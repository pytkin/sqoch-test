"""Future organizer flows against the real HTTP boundary, without product stubs."""

import sqlite3
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from threading import Barrier, Event
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from sqoch_api.app import create_app
from sqoch_api.notifications import campaign_queries, service
from sqoch_api.notifications.schemas import CampaignDetail, SaveCampaignRequest
from sqoch_api.notifications.store import connect_db, load_demo

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "demo.json"
FUTURE_DATE = "2099-11-20T19:00:00+03:00"


def reviewed_draft(client: TestClient, database_path: Path) -> tuple[str, dict[str, object]]:
    campaign_id = str(uuid4())
    path = f"/api/organizer/campaigns/{campaign_id}"
    created = client.put(path, json={})
    assert created.status_code == 201
    load_demo(database_path, FIXTURE_PATH)
    events = client.get("/api/organizer/events")
    assert events.status_code == 200
    event = next(item for item in events.json()["items"] if item["id"] == "ceramics")
    saved = client.patch(
        path,
        json={
            "expected_revision": created.json()["revision"],
            "event_id": "ceramics",
            "proposed_start": FUTURE_DATE,
            "subject": "Перенос мастер-класса",
            "body": "Мастер-класс перенесён на 20 ноября 2099 года, 19:00 (Москва).",
            "text_reviewed": True,
            "reviewed_event_revision": event["revision"],
        },
    )
    assert saved.status_code == 200
    return path, saved.json()


@pytest.mark.parametrize("confirmed", [False, True])
def test_list_identifies_campaign_by_subject_and_transfer_date(
    draft_client: TestClient, database_path: Path, confirmed: bool
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    if confirmed:
        preview = draft_client.post(
            f"{path}/preview", json={"expected_revision": draft["revision"]}
        )
        assert preview.status_code == 200
        assert (
            draft_client.post(
                f"{path}/confirm", json={"preview_token": preview.json()["token"]}
            ).status_code
            == 202
        )
    response = draft_client.get("/api/organizer/campaigns")
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["subject"] == draft["subject"]
    assert item["proposed_start"] == FUTURE_DATE
    assert item["event_title"] == "Керамика"
    assert item["phase"] == ("confirmed" if confirmed else "draft")


def test_list_keeps_empty_draft_identifiable_without_inventing_content(
    draft_client: TestClient,
) -> None:
    assert draft_client.put(f"/api/organizer/campaigns/{uuid4()}", json={}).status_code == 201
    response = draft_client.get("/api/organizer/campaigns")
    assert response.status_code == 200
    assert response.json()["items"][0]["subject"] == ""
    assert response.json()["items"][0]["proposed_start"] is None


def test_preview_shows_unique_recipients_and_does_not_create_deliveries(
    draft_client: TestClient, database_path: Path
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    preview = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert preview.status_code == 200
    result = preview.json()
    assert result["recipients"] == [f"{name}@example.com" for name in "abcdefgh"]
    assert result["event"]["id"] == "ceramics"
    assert result["draft_revision"] == draft["revision"]
    assert result["proposed_start"] == FUTURE_DATE
    repeated = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert repeated.status_code == 200
    assert repeated.json()["token"] == result["token"]
    detail = draft_client.get(path).json()
    assert detail["phase"] == "draft"
    assert detail["deliveries"] == []
    assert detail["counters"]["total"] == 0


def test_event_change_before_first_preview_requires_new_human_review(
    draft_client: TestClient, database_path: Path
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    with connect_db(database_path) as connection:
        connection.execute("UPDATE events SET revision=revision+1 WHERE id='ceramics'")
    response = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "text_review_required"
    assert draft_client.get(path).json()["phase"] == "draft"


def test_confirmation_is_atomic_and_repeat_is_same_campaign(
    draft_client: TestClient, database_path: Path
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    preview = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert preview.status_code == 200
    token = preview.json()["token"]
    confirmed = draft_client.post(f"{path}/confirm", json={"preview_token": token})
    assert confirmed.status_code == 202
    campaign = confirmed.json()
    assert campaign["phase"] == "confirmed"
    assert campaign["counters"]["total"] == 8
    assert campaign["counters"]["pending"] == 8
    assert len(campaign["deliveries"]) == 8
    assert len({row["email"] for row in campaign["deliveries"]}) == 8
    assert all(row["attempts"] == 0 for row in campaign["deliveries"])
    repeated = draft_client.post(f"{path}/confirm", json={"preview_token": token})
    assert repeated.status_code == 200
    assert repeated.json() == campaign
    event = next(
        item
        for item in draft_client.get("/api/organizer/events").json()["items"]
        if item["id"] == "ceramics"
    )
    assert event["starts_at"] == FUTURE_DATE


def test_purchase_change_with_same_email_list_invalidates_confirmation(
    draft_client: TestClient, database_path: Path
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    preview = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert preview.status_code == 200
    with connect_db(database_path) as connection:
        connection.execute("UPDATE purchases SET status='cancelled' WHERE id='p09'")
    response = draft_client.post(f"{path}/confirm", json={"preview_token": preview.json()["token"]})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "preview_stale"
    campaign = draft_client.get(path).json()
    assert campaign["phase"] == "draft"
    assert campaign["deliveries"] == []


@pytest.mark.parametrize("field,value", [("subject", ""), ("body", ""), ("proposed_start", None)])
def test_incomplete_preview_does_not_confirm_or_change_event(
    draft_client: TestClient, database_path: Path, field: str, value: object
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    payload = {
        "expected_revision": draft["revision"],
        "event_id": "ceramics",
        "proposed_start": FUTURE_DATE,
        "subject": "Перенос",
        "body": "Новая дата",
        "text_reviewed": False,
        field: value,
    }
    changed = draft_client.patch(path, json=payload)
    assert changed.status_code == 200
    response = draft_client.post(
        f"{path}/preview", json={"expected_revision": changed.json()["revision"]}
    )
    assert response.status_code == 422
    assert any(item["loc"] == ["body", field] for item in response.json()["detail"])
    assert draft_client.get(path).json()["deliveries"] == []


def test_confirm_without_preview_is_rejected(draft_client: TestClient) -> None:
    path = f"/api/organizer/campaigns/{uuid4()}"
    assert draft_client.put(path, json={}).status_code == 201
    response = draft_client.post(f"{path}/confirm", json={"preview_token": str(uuid4())})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "preview_stale"
    assert draft_client.get(path).json()["phase"] == "draft"


@pytest.mark.parametrize("subject", ["\nПеренос", "Перенос\r", "Новая\nдата"])
def test_subject_rejects_line_breaks_even_at_trimmed_edges(
    draft_client: TestClient, subject: str
) -> None:
    path = f"/api/organizer/campaigns/{uuid4()}"
    assert draft_client.put(path, json={}).status_code == 201
    response = draft_client.patch(
        path,
        json={
            "expected_revision": 0,
            "event_id": None,
            "proposed_start": None,
            "subject": subject,
            "body": "Текст",
            "text_reviewed": False,
        },
    )
    assert response.status_code == 422
    assert draft_client.get(path).json()["revision"] == 0


def test_no_recipients_prevents_preview(draft_client: TestClient, database_path: Path) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    with connect_db(database_path) as connection:
        connection.execute("UPDATE purchases SET status='cancelled' WHERE event_id='ceramics'")
    response = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "no_recipients"
    assert draft_client.get(path).json()["deliveries"] == []


def test_failure_after_first_delivery_rolls_back_date_and_confirmation(
    draft_client: TestClient, database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    before = draft_client.get("/api/organizer/events").json()
    preview = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert preview.status_code == 200
    original = service._insert_delivery

    def fail_after_insert(
        connection: sqlite3.Connection,
        campaign_id: str,
        recipient: str,
        subject: str,
        body: str,
        now: datetime,
    ) -> None:
        original(connection, campaign_id, recipient, subject, body, now)
        raise sqlite3.OperationalError("PRIVATE_STORAGE_ERROR")

    monkeypatch.setattr(service, "_insert_delivery", fail_after_insert)
    response = draft_client.post(f"{path}/confirm", json={"preview_token": preview.json()["token"]})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "storage_unavailable"
    assert "PRIVATE_STORAGE_ERROR" not in response.text
    assert draft_client.get("/api/organizer/events").json() == before
    unchanged = draft_client.get(path).json()
    assert unchanged["phase"] == "draft"
    assert unchanged["revision"] == draft["revision"]
    assert unchanged["deliveries"] == []


def test_two_connections_confirm_once(
    draft_client: TestClient, database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    preview = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert preview.status_code == 200
    original = connect_db
    barrier = Barrier(2, timeout=5)

    @contextmanager
    def simultaneous_connection(path: Path) -> Iterator[sqlite3.Connection]:
        with original(path) as connection:
            barrier.wait()
            yield connection

    monkeypatch.setattr(service, "connect_db", simultaneous_connection)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(
                draft_client.post,
                f"{path}/confirm",
                json={"preview_token": preview.json()["token"]},
            )
            for _ in range(2)
        ]
        results = [future.result(timeout=10) for future in futures]
    assert sorted(response.status_code for response in results) == [200, 202]
    assert results[0].json() == results[1].json()
    with original(database_path) as connection:
        assert connection.execute("SELECT count(*) FROM deliveries").fetchone()[0] == 8


def test_date_becomes_past_after_preview_and_no_state_changes(
    database_path: Path,
) -> None:
    now = [datetime(2026, 10, 26, tzinfo=UTC)]
    app = create_app(
        frontend_dir=database_path.parent / "absent",
        clock=lambda: now[0],
        allowed_hosts=("testserver",),
    )
    with TestClient(app) as client:
        path, draft = reviewed_draft(client, database_path)
        preview = client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
        assert preview.status_code == 200
        now[0] = datetime.fromisoformat(FUTURE_DATE)
        response = client.post(f"{path}/confirm", json={"preview_token": preview.json()["token"]})
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "date_not_future"
        assert client.get(path).json()["phase"] == "draft"
        assert client.get(path).json()["deliveries"] == []


@pytest.mark.parametrize("unsettled_state", ["pending", "sending", "retry_wait", "unknown"])
@pytest.mark.parametrize("terminal_state", ["sent", "failed"])
def test_unsettled_same_event_blocks_next_transfer_until_terminal(
    draft_client: TestClient,
    database_path: Path,
    unsettled_state: str,
    terminal_state: str,
) -> None:
    first_path, first = reviewed_draft(draft_client, database_path)
    preview = draft_client.post(
        f"{first_path}/preview", json={"expected_revision": first["revision"]}
    )
    assert preview.status_code == 200
    assert (
        draft_client.post(
            f"{first_path}/confirm", json={"preview_token": preview.json()["token"]}
        ).status_code
        == 202
    )
    with connect_db(database_path) as connection:
        connection.execute("UPDATE deliveries SET state=?", (unsettled_state,))
    second_path, second = reviewed_draft(draft_client, database_path)
    next_preview = draft_client.post(
        f"{second_path}/preview", json={"expected_revision": second["revision"]}
    )
    assert next_preview.status_code == 200
    token = next_preview.json()["token"]
    before_campaign = draft_client.get(second_path).json()
    before_events = draft_client.get("/api/organizer/events").json()
    refused = draft_client.post(f"{second_path}/confirm", json={"preview_token": token})
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "event_campaign_unsettled"
    assert refused.json()["detail"]["related_campaign_id"] == first_path.rsplit("/", 1)[1]
    assert draft_client.get(second_path).json() == before_campaign
    assert draft_client.get("/api/organizer/events").json() == before_events
    with connect_db(database_path) as connection:
        connection.execute("UPDATE deliveries SET state=?", (terminal_state,))
    assert (
        draft_client.post(f"{second_path}/confirm", json={"preview_token": token}).status_code
        == 202
    )


def test_unsettled_other_event_does_not_block_confirmation(
    draft_client: TestClient, database_path: Path
) -> None:
    first_path, first = reviewed_draft(draft_client, database_path)
    first_preview = draft_client.post(
        f"{first_path}/preview", json={"expected_revision": first["revision"]}
    )
    assert first_preview.status_code == 200
    assert (
        draft_client.post(
            f"{first_path}/confirm", json={"preview_token": first_preview.json()["token"]}
        ).status_code
        == 202
    )
    with connect_db(database_path) as connection:
        connection.execute("UPDATE deliveries SET state='unknown'")
    second_path, second = reviewed_draft(draft_client, database_path)
    changed = draft_client.patch(
        second_path,
        json={
            "expected_revision": second["revision"],
            "event_id": "painting",
            "proposed_start": FUTURE_DATE,
            "subject": "Перенос живописи",
            "body": "Новое время занятия живописью",
            "text_reviewed": True,
            "reviewed_event_revision": 0,
        },
    )
    assert changed.status_code == 200
    second_preview = draft_client.post(
        f"{second_path}/preview", json={"expected_revision": changed.json()["revision"]}
    )
    assert second_preview.status_code == 200
    confirmed = draft_client.post(
        f"{second_path}/confirm", json={"preview_token": second_preview.json()["token"]}
    )
    assert confirmed.status_code == 202
    assert confirmed.json()["event_id"] == "painting"
    assert confirmed.json()["counters"]["total"] == 5
    assert draft_client.get(first_path).json()["counters"]["unknown"] == 8


@pytest.mark.parametrize(
    "date",
    [
        "9999-12-31T23:59:59-12:00",
        "9999-12-31T23:59:59Z",
        "0001-01-01T00:00:00+14:00",
    ],
)
def test_unrepresentable_manual_date_is_field_error_without_changing_draft(
    database_path: Path, date: str
) -> None:
    with TestClient(
        create_app(frontend_dir=database_path.parent / "absent", allowed_hosts=("testserver",)),
        raise_server_exceptions=False,
    ) as client:
        path, draft = reviewed_draft(client, database_path)
        before_events = client.get("/api/organizer/events").json()
        response = client.patch(
            path,
            json={
                "expected_revision": draft["revision"],
                "event_id": "ceramics",
                "proposed_start": date,
                "subject": "Изменённая тема",
                "body": "Изменённый текст",
                "text_reviewed": False,
            },
        )
        assert response.status_code == 422
        assert any(
            issue["loc"] == ["body", "proposed_start"] for issue in response.json()["detail"]
        )
        assert client.get(path).json() == draft
        assert client.get("/api/organizer/events").json() == before_events


def test_local_boundary_rejects_bad_host_origin_and_non_json(database_path: Path) -> None:
    with TestClient(create_app(frontend_dir=database_path.parent / "absent")) as client:
        assert client.get("/api/organizer/events").status_code == 400
        assert client.get("/api/event").status_code == 200
        path = f"/api/organizer/campaigns/{uuid4()}"
        assert (
            client.put(
                path, json={}, headers={"Host": "127.0.0.1", "Origin": "https://evil.example.com"}
            ).status_code
            == 403
        )
        assert (
            client.put(
                path, content="{}", headers={"Host": "127.0.0.1", "Content-Type": "text/plain"}
            ).status_code
            == 415
        )
        assert (
            client.put(
                path, json={}, headers={"Host": "127.0.0.1", "Origin": "http://127.0.0.1:5173"}
            ).status_code
            == 201
        )


def test_openapi_export_does_not_create_database(database_path: Path) -> None:
    app = create_app()
    assert "/api/organizer/campaigns/{campaign_id}/confirm" in app.openapi()["paths"]
    assert not database_path.exists()


@pytest.mark.parametrize("date", [True, 1000000000, "2099-11-20T19:00:00", "2099-11-20T16:00:00Z"])
def test_date_input_rejects_non_iso_or_non_moscow_values(
    draft_client: TestClient, date: object
) -> None:
    path = f"/api/organizer/campaigns/{uuid4()}"
    assert draft_client.put(path, json={}).status_code == 201
    response = draft_client.patch(
        path,
        json={
            "expected_revision": 0,
            "event_id": None,
            "proposed_start": date,
            "subject": "",
            "body": "",
            "text_reviewed": False,
        },
    )
    assert response.status_code == 422
    assert any(issue["loc"] == ["body", "proposed_start"] for issue in response.json()["detail"])


def test_request_model_requires_iso_string_not_datetime_object() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        SaveCampaignRequest.model_validate(
            {
                "expected_revision": 0,
                "event_id": None,
                "proposed_start": datetime.fromisoformat(FUTURE_DATE),
                "subject": "",
                "body": "",
                "text_reviewed": False,
            }
        )


def test_confirmed_campaign_rejects_edits_and_other_token(
    draft_client: TestClient, database_path: Path
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    preview = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert preview.status_code == 200
    confirmed = draft_client.post(
        f"{path}/confirm", json={"preview_token": preview.json()["token"]}
    )
    assert confirmed.status_code == 202
    refused = draft_client.patch(
        path,
        json={
            "expected_revision": draft["revision"],
            "event_id": None,
            "proposed_start": None,
            "subject": "Изменено",
            "body": "Изменено",
            "text_reviewed": False,
        },
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "campaign_immutable"
    conflict = draft_client.post(f"{path}/confirm", json={"preview_token": str(uuid4())})
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "confirmation_conflict"
    load_demo(database_path, FIXTURE_PATH)
    assert draft_client.get(path).json() == confirmed.json()


def test_organizer_schema_requires_all_response_keys(draft_client: TestClient) -> None:
    schemas = draft_client.get("/openapi.json").json()["components"]["schemas"]
    for name in (
        "OrganizerEvent",
        "CampaignDetail",
        "CampaignCounters",
        "CampaignDelivery",
        "CampaignPreview",
        "OrganizerErrorDetail",
    ):
        assert set(schemas[name]["properties"]) == set(schemas[name]["required"]), name


@pytest.mark.parametrize("view", ["detail", "list"])
def test_read_view_does_not_mix_draft_row_with_confirmed_deliveries(
    draft_client: TestClient, database_path: Path, monkeypatch: pytest.MonkeyPatch, view: str
) -> None:
    path, draft = reviewed_draft(draft_client, database_path)
    preview = draft_client.post(f"{path}/preview", json={"expected_revision": draft["revision"]})
    assert preview.status_code == 200
    row_read = Event()
    confirm_committed = Event()
    original_detail = campaign_queries.campaign_detail

    def pause_after_draft_row(connection: sqlite3.Connection, row: sqlite3.Row) -> CampaignDetail:
        if row["phase"] == "draft":
            row_read.set()
            assert confirm_committed.wait(timeout=5)
        return original_detail(connection, row)

    monkeypatch.setattr(campaign_queries, "campaign_detail", pause_after_draft_row)
    endpoint = path if view == "detail" else "/api/organizer/campaigns"
    with ThreadPoolExecutor(max_workers=1) as pool:
        response_future = pool.submit(draft_client.get, endpoint)
        try:
            assert row_read.wait(timeout=5)
            confirmed = draft_client.post(
                f"{path}/confirm", json={"preview_token": preview.json()["token"]}
            )
            assert confirmed.status_code == 202
        finally:
            confirm_committed.set()
        response = response_future.result(timeout=5)
    assert response.status_code == 200
    campaign = response.json() if view == "detail" else response.json()["items"][0]
    assert campaign["phase"] == "draft"
    assert campaign["counters"]["total"] == 0
    assert campaign["counters"]["pending"] == 0
    if view == "detail":
        assert campaign["deliveries"] == []


@pytest.mark.parametrize("field,limit", [("subject", 200), ("body", 10000)])
def test_text_length_limits_apply_after_outer_whitespace_is_removed(
    draft_client: TestClient, field: str, limit: int
) -> None:
    path = f"/api/organizer/campaigns/{uuid4()}"
    assert draft_client.put(path, json={}).status_code == 201
    payload = {
        "expected_revision": 0,
        "event_id": None,
        "proposed_start": None,
        "subject": "Тема",
        "body": "Текст",
        "text_reviewed": False,
        field: "  " + "я" * limit + "  ",
    }
    accepted = draft_client.patch(path, json=payload)
    assert accepted.status_code == 200
    assert accepted.json()[field] == "я" * limit
    rejected = draft_client.patch(
        path,
        json={
            **payload,
            "expected_revision": accepted.json()["revision"],
            field: "  " + "я" * (limit + 1) + "  ",
        },
    )
    assert rejected.status_code == 422
    assert draft_client.get(path).json() == accepted.json()
