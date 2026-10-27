from email import policy
from email.parser import BytesParser
from pathlib import Path

import httpx
import pytest
from delivery_helpers import NOW, confirmed_campaign
from fastapi.testclient import TestClient

from sqoch_api.notifications import service
from sqoch_api.notifications.delivery import (
    DeliveryJob,
    claim_next,
    reconcile_campaign,
    recover_sending,
)
from sqoch_api.notifications.mailpit import MailpitClient, MatchResult
from sqoch_api.notifications.store import connect_db


def delivery_job(tmp_path: Path) -> DeliveryJob:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    job = claim_next(path, NOW)
    assert job is not None
    return job


def hit(job: DeliveryJob, identifier: str = "known") -> dict[str, object]:
    return {"ID": identifier, "MessageID": job.message_id.strip("<>")}


def test_exact_search_uses_filtered_count_paginates_and_reads_raw_message(tmp_path: Path) -> None:
    job = delivery_job(tmp_path)
    calls: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url.path.endswith("/search"):
            assert request.url.params["query"] == f"message-id:{job.message_id.strip('<>')}"
            if request.url.params["start"] == "0":
                return httpx.Response(
                    200,
                    json={
                        "total": 1000,
                        "messages_count": 2,
                        "messages": [
                            {"ID": "partial", "MessageID": "prefix-" + job.message_id.strip("<>")}
                        ],
                    },
                )
            return httpx.Response(
                200, json={"total": 1000, "messages_count": 2, "messages": [hit(job)]}
            )
        assert request.url.path == "/api/v1/message/known/raw"
        return httpx.Response(200, content=job.mime)

    result = MailpitClient("http://127.0.0.1:8025", transport=httpx.MockTransport(respond)).check(
        job
    )
    assert result.code == "matched"
    assert result.message_id == "known"
    assert len(calls) == 3


@pytest.mark.parametrize("difference", ["to", "from", "campaign", "subject", "body", "message_id"])
def test_false_correspondence_is_not_success(tmp_path: Path, difference: str) -> None:
    job = delivery_job(tmp_path)
    message = BytesParser(policy=policy.default).parsebytes(job.mime)
    headers = {
        "to": "To",
        "from": "From",
        "campaign": "X-Sqoch-Campaign-ID",
        "subject": "Subject",
        "message_id": "Message-ID",
    }
    if difference == "body":
        message.set_payload("Changed body")
    else:
        message.replace_header(headers[difference], "wrong@example.com")

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/search"):
            return httpx.Response(200, json={"messages_count": 1, "messages": [hit(job)]})
        return httpx.Response(200, content=message.as_bytes())

    result = MailpitClient("http://127.0.0.1:8025", transport=httpx.MockTransport(respond)).check(
        job
    )
    assert result.code == "mailpit_mismatch"


@pytest.mark.parametrize(
    "scenario", ["missing", "duplicates", "api_error", "invalid_json", "redirect"]
)
def test_missing_duplicate_or_unavailable_evidence_never_proves_delivery(
    tmp_path: Path, scenario: str
) -> None:
    job = delivery_job(tmp_path)

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/search")
        if scenario == "missing":
            return httpx.Response(200, json={"total": 100, "messages_count": 0, "messages": []})
        if scenario == "duplicates":
            return httpx.Response(
                200, json={"messages_count": 2, "messages": [hit(job, "first"), hit(job, "second")]}
            )
        if scenario == "redirect":
            return httpx.Response(302, headers={"Location": "http://outside.example.com/"})
        return httpx.Response(503 if scenario == "api_error" else 200, content="INVALID")

    result = MailpitClient("http://127.0.0.1:8025", transport=httpx.MockTransport(respond)).check(
        job
    )
    assert result.code == {
        "missing": "not_found_in_mailpit",
        "duplicates": "mailpit_duplicates",
    }.get(scenario, "mailpit_unavailable")


def test_positive_readback_completes_exhausted_unknown_without_smtp(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent'")
        connection.execute(
            "UPDATE deliveries SET state='sending',attempts=5 WHERE email='a@example.com'"
        )
    recover_sending(path)
    checked: list[int] = []

    def checker(job: DeliveryJob) -> MatchResult:
        checked.append(job.attempts)
        return MatchResult("matched", "mailpit-id")

    result = reconcile_campaign(path, campaign_id, checker, lambda: NOW)
    assert checked == [5]
    assert result.status == "completed"
    assert result.counters.sent == 8
    with connect_db(path) as connection:
        row = connection.execute("SELECT * FROM deliveries WHERE email='a@example.com'").fetchone()
        assert row["attempts"] == 5
        assert row["mailpit_message_id"] == "mailpit-id"
    assert reconcile_campaign(path, campaign_id, checker, lambda: NOW).status == "completed"
    assert checked == [5]


def test_late_negative_reconcile_cannot_lower_success(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent'")
        connection.execute(
            "UPDATE deliveries SET state='unknown',attempts=1 WHERE email='a@example.com'"
        )

    def late_negative(job: DeliveryJob) -> MatchResult:
        reconcile_campaign(
            path, campaign_id, lambda current: MatchResult("matched", "verified"), lambda: NOW
        )
        return MatchResult("mailpit_unavailable")

    result = reconcile_campaign(path, campaign_id, late_negative, lambda: NOW)
    delivery = next(item for item in result.deliveries if item.email == "a@example.com")
    assert delivery.state == "sent"
    assert delivery.error_code is None


def test_negative_readback_retains_unknown_and_attempt_budget(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='unknown',attempts=3")
    result = reconcile_campaign(
        path, campaign_id, lambda job: MatchResult("not_found_in_mailpit"), lambda: NOW
    )
    assert result.status == "needs_attention"
    assert result.counters.unknown == 8
    assert all(
        item.attempts == 3 and item.error_code == "not_found_in_mailpit"
        for item in result.deliveries
    )
    assert service.get_campaign(path, campaign_id).phase == "confirmed"


def test_reconcile_endpoint_returns_saved_result_without_restarting_smtp(
    draft_client: TestClient, database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqoch_api.notifications import routes

    campaign_id = confirmed_campaign(database_path)
    with connect_db(database_path) as connection:
        connection.execute("UPDATE deliveries SET state='unknown',attempts=5")

    class VerifiedMailpit:
        def __init__(self, base_url: str) -> None:
            assert base_url == "http://127.0.0.1:8025"

        def check(self, job: DeliveryJob) -> MatchResult:
            return MatchResult("matched", "verified-" + job.id)

    monkeypatch.setattr(routes, "MailpitClient", VerifiedMailpit, raising=False)
    response = draft_client.post(f"/api/organizer/campaigns/{campaign_id}/reconcile", json={})
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert all(row["attempts"] == 5 for row in response.json()["deliveries"])
