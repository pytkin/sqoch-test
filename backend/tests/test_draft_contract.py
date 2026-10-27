"""Executable HTTP contract for saved drafts, validation and immutable confirmations."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sqoch_api.app import create_app

CAMPAIGN_ID = "93ce9274-81a3-451e-8b90-993cf03be1d3"
CAMPAIGN_PATH = f"/api/organizer/campaigns/{CAMPAIGN_ID}"
EMPTY_DRAFT: dict[str, object] = {
    "id": CAMPAIGN_ID,
    "phase": "draft",
    "revision": 0,
    "event_id": None,
    "proposed_start": None,
    "subject": "",
    "body": "",
    "text_reviewed": False,
}
EDIT: dict[str, object] = {
    "expected_revision": 0,
    "event_id": None,
    "proposed_start": None,
    "subject": "Перенос занятия",
    "body": "Новую дату ещё нужно выбрать.",
    "text_reviewed": False,
}


def create_draft(client: TestClient) -> None:
    response = client.put(CAMPAIGN_PATH, json={})
    assert response.status_code == 201
    assert {key: response.json()[key] for key in EMPTY_DRAFT} == EMPTY_DRAFT


def test_create_and_read_empty_draft(draft_client: TestClient) -> None:
    create_draft(draft_client)
    response = draft_client.get(CAMPAIGN_PATH)
    assert response.status_code == 200
    assert {key: response.json()[key] for key in EMPTY_DRAFT} == EMPTY_DRAFT


def test_repeat_create_preserves_saved_incomplete_draft(draft_client: TestClient) -> None:
    create_draft(draft_client)
    saved = draft_client.patch(CAMPAIGN_PATH, json=EDIT)
    assert saved.status_code == 200
    expected = {
        **EMPTY_DRAFT,
        **{key: value for key, value in EDIT.items() if key != "expected_revision"},
        "revision": 1,
    }
    assert {key: saved.json()[key] for key in expected} == expected
    repeated = draft_client.put(CAMPAIGN_PATH, json={})
    assert repeated.status_code == 200
    assert {key: repeated.json()[key] for key in expected} == expected
    readback = draft_client.get(CAMPAIGN_PATH)
    assert readback.status_code == 200
    assert {key: readback.json()[key] for key in expected} == expected


def test_stale_save_rejects_overwrite(draft_client: TestClient) -> None:
    create_draft(draft_client)
    saved = draft_client.patch(CAMPAIGN_PATH, json=EDIT)
    assert saved.status_code == 200
    stale = draft_client.patch(CAMPAIGN_PATH, json={**EDIT, "subject": "Устаревшая правка"})
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "revision_conflict"
    readback = draft_client.get(CAMPAIGN_PATH)
    assert readback.status_code == 200
    assert readback.json() == saved.json()


@pytest.mark.parametrize("method", ["get", "put"])
def test_invalid_campaign_uuid_is_field_error(draft_client: TestClient, method: str) -> None:
    response = draft_client.request(method, "/api/organizer/campaigns/not-a-uuid", json={})
    assert response.status_code == 422
    assert any(issue["loc"] == ["path", "campaign_id"] for issue in response.json()["detail"])


def test_create_rejects_unknown_fields(draft_client: TestClient) -> None:
    response = draft_client.put(CAMPAIGN_PATH, json={"recipients": ["a@example.com"]})
    assert response.status_code == 422
    assert any(issue["loc"] == ["body", "recipients"] for issue in response.json()["detail"])


def test_save_rejects_unknown_fields_without_mutating_draft(draft_client: TestClient) -> None:
    create_draft(draft_client)
    response = draft_client.patch(CAMPAIGN_PATH, json={**EDIT, "recipients": []})
    assert response.status_code == 422
    assert any(issue["loc"] == ["body", "recipients"] for issue in response.json()["detail"])
    readback = draft_client.get(CAMPAIGN_PATH)
    assert readback.status_code == 200
    assert {key: readback.json()[key] for key in EMPTY_DRAFT} == EMPTY_DRAFT


def test_unknown_campaign_has_stable_error(draft_client: TestClient) -> None:
    response = draft_client.get(CAMPAIGN_PATH)
    assert response.status_code == 404
    detail = response.json()["detail"]
    assert isinstance(detail, dict)
    assert detail["code"] == "not_found"


def test_saved_draft_survives_new_app_and_other_database_is_isolated(
    database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    frontend_dir = database_path.parent / "missing-dist"
    with TestClient(create_app(frontend_dir=frontend_dir, allowed_hosts=("testserver",))) as first:
        create_draft(first)
        saved = first.patch(CAMPAIGN_PATH, json=EDIT)
        assert saved.status_code == 200
    with TestClient(
        create_app(frontend_dir=frontend_dir, allowed_hosts=("testserver",))
    ) as restarted:
        readback = restarted.get(CAMPAIGN_PATH)
        assert readback.status_code == 200
        assert readback.json() == saved.json()
    monkeypatch.setenv("SQOCH_DATABASE_PATH", str(database_path.parent / "other.sqlite3"))
    with TestClient(
        create_app(frontend_dir=frontend_dir, allowed_hosts=("testserver",))
    ) as isolated:
        response = isolated.get(CAMPAIGN_PATH)
        assert response.status_code == 404
        detail = response.json()["detail"]
        assert isinstance(detail, dict)
        assert detail["code"] == "not_found"
