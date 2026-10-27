from datetime import timedelta
from pathlib import Path

import pytest
from delivery_helpers import NOW, confirmed_campaign
from fastapi.testclient import TestClient

from sqoch_api.notifications import service
from sqoch_api.notifications.delivery import (
    DeliveryJob,
    claim_next,
    process_one,
    record_result,
    resume_campaign,
)
from sqoch_api.notifications.errors import OrganizerError
from sqoch_api.notifications.smtp import SendResult
from sqoch_api.notifications.store import connect_db


def test_five_attempt_budget_is_shared_by_automatic_manual_and_restarted_processing(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    now = [NOW]
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent' WHERE email!='a@example.com'")
    calls: list[int] = []

    def sender(job: DeliveryJob) -> SendResult:
        with connect_db(path) as connection:
            row = connection.execute(
                "SELECT state,attempts FROM deliveries WHERE id=?", (job.id,)
            ).fetchone()
            assert tuple(row) == ("sending", job.attempts)
        calls.append(job.attempts)
        return SendResult("retry_wait", "smtp_temporary_failure", "Служба временно недоступна")

    for attempt, delay in enumerate([5, 15, 60, 120], start=1):
        assert process_one(path, sender, lambda: now[0])
        assert calls == list(range(1, attempt + 1))
        assert not process_one(path, sender, lambda: now[0])
        detail = service.get_campaign(path, campaign_id)
        failed = next(item for item in detail.deliveries if item.email == "a@example.com")
        assert failed.next_attempt_at == now[0] + timedelta(seconds=delay)
        if attempt % 2:
            resume_campaign(path, campaign_id, lambda: now[0])
        else:
            now[0] += timedelta(seconds=delay)
    assert process_one(path, sender, lambda: now[0])
    assert calls == [1, 2, 3, 4, 5]
    for _ in range(3):
        resume_campaign(path, campaign_id, lambda: now[0])
        assert not process_one(path, sender, lambda: now[0] + timedelta(days=1))
    final = service.get_campaign(path, campaign_id)
    assert final.status == "completed_with_errors"
    delivery = next(item for item in final.deliveries if item.email == "a@example.com")
    assert delivery.state == "failed"
    assert delivery.attempts == 5
    assert delivery.error_code == "attempts_exhausted"


@pytest.mark.parametrize("outcome", ["sent", "failed", "unknown"])
def test_terminal_and_unknown_outcomes_are_not_retried(tmp_path: Path, outcome: str) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent' WHERE email!='a@example.com'")
    result = {
        "sent": SendResult("sent"),
        "failed": SendResult("failed", "smtp_permanent_failure", "Отправка отклонена"),
        "unknown": SendResult("unknown", "smtp_outcome_unknown", "Требует проверки"),
    }[outcome]
    assert process_one(path, lambda job: result, lambda: NOW)
    resume_campaign(path, campaign_id, lambda: NOW)
    assert not process_one(path, lambda job: pytest.fail("Unexpected retry"), lambda: NOW)
    detail = service.get_campaign(path, campaign_id)
    assert sum(detail.counters.model_dump().values()) == detail.counters.total * 2
    assert (
        detail.status
        == {"sent": "completed", "failed": "completed_with_errors", "unknown": "needs_attention"}[
            outcome
        ]
    )


def test_resume_of_draft_is_rejected_without_creating_deliveries(tmp_path: Path) -> None:
    from uuid import uuid4

    from sqoch_api.notifications.store import init_db

    path = tmp_path / "state.sqlite3"
    init_db(path)
    campaign_id = uuid4()
    service.create_campaign(path, campaign_id, lambda: NOW)
    with pytest.raises(OrganizerError) as error:
        resume_campaign(path, campaign_id, lambda: NOW)
    assert error.value.detail.code == "campaign_not_confirmed"
    assert service.get_campaign(path, campaign_id).deliveries == []


def test_resume_endpoint_keeps_attempts_and_terminal_states(
    draft_client: TestClient, database_path: Path
) -> None:
    campaign_id = confirmed_campaign(database_path)
    with connect_db(database_path) as connection:
        connection.execute("UPDATE deliveries SET state='sent'")
        connection.execute(
            "UPDATE deliveries SET state='retry_wait',attempts=2,"
            "next_attempt_at='2099-12-31T00:00:00Z' WHERE email='a@example.com'"
        )
        connection.execute(
            "UPDATE deliveries SET state='unknown',attempts=5 WHERE email='b@example.com'"
        )
    response = draft_client.post(f"/api/organizer/campaigns/{campaign_id}/resume", json={})
    assert response.status_code == 200
    rows = {row["email"]: row for row in response.json()["deliveries"]}
    assert rows["a@example.com"]["attempts"] == 2
    assert rows["a@example.com"]["state"] == "retry_wait"
    assert rows["a@example.com"]["next_attempt_at"] != "2099-12-31T00:00:00Z"
    assert rows["b@example.com"]["state"] == "unknown"
    assert response.json()["counters"]["sent"] == 6


@pytest.mark.parametrize("state,attempt_delta", [("sent", 0), ("unknown", 0), ("sending", 1)])
def test_stale_result_cannot_overwrite_recovered_or_newer_delivery(
    tmp_path: Path, state: str, attempt_delta: int
) -> None:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    job = claim_next(path, NOW)
    assert job is not None
    with connect_db(path) as connection:
        connection.execute(
            "UPDATE deliveries SET state=?,attempts=?,mailpit_message_id=? WHERE id=?",
            (state, job.attempts + attempt_delta, "verified" if state == "sent" else None, job.id),
        )
        before = tuple(
            connection.execute("SELECT * FROM deliveries WHERE id=?", (job.id,)).fetchone()
        )
    record_result(
        path,
        job,
        SendResult("retry_wait", "smtp_temporary_failure", "Поздний отказ"),
        NOW + timedelta(seconds=1),
    )
    with connect_db(path) as connection:
        after = tuple(
            connection.execute("SELECT * FROM deliveries WHERE id=?", (job.id,)).fetchone()
        )
    assert after == before


@pytest.mark.parametrize(
    "states,expected_status",
    [
        (["pending", "unknown", "failed"], "processing"),
        (["sending", "unknown", "failed"], "processing"),
        (["retry_wait", "unknown", "failed"], "processing"),
        (["unknown", "failed"], "needs_attention"),
        (["failed"], "completed_with_errors"),
        ([], "completed"),
    ],
)
def test_progress_counts_every_recipient_and_prioritizes_unsettled_outcomes(
    tmp_path: Path, states: list[str], expected_status: str
) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent'")
        for email, state in zip("abcdefgh", states, strict=False):
            connection.execute(
                "UPDATE deliveries SET state=? WHERE email=?", (state, f"{email}@example.com")
            )
    expected_counts = {
        "total": 8,
        "pending": int("pending" in states),
        "sending": int("sending" in states),
        "retry_wait": int("retry_wait" in states),
        "sent": 8 - len(states),
        "failed": int("failed" in states),
        "unknown": int("unknown" in states),
    }
    detail = service.get_campaign(path, campaign_id)
    summary = service.list_campaigns(path).items[0]
    assert detail.status == summary.status == expected_status
    assert detail.counters.model_dump() == summary.counters.model_dump() == expected_counts
    assert sum(expected_counts[name] for name in expected_counts if name != "total") == 8
