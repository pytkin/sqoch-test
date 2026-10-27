import json
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_ai_prepare import (
    CAMPAIGN_PATH,
    completion,
    create_fixture_draft,
)
from test_ai_prepare import (
    ai_client_factory as ai_client_factory,
)

from sqoch_api.notifications.store import connect_db


def save_full_draft(client: TestClient) -> dict[str, object]:
    response = client.patch(
        CAMPAIGN_PATH,
        json={
            "expected_revision": 0,
            "event_id": "ceramics",
            "proposed_start": "2099-11-20T19:00:00+03:00",
            "subject": "Сохранённая тема",
            "body": "Сохранённый текст",
            "text_reviewed": True,
            "reviewed_event_revision": 0,
        },
    )
    assert response.status_code == 200
    return dict(response.json())


def test_rewrite_without_key_does_not_replace_existing_text(draft_client: TestClient) -> None:
    assert draft_client.put(CAMPAIGN_PATH, json={}).status_code == 201
    saved = draft_client.patch(
        CAMPAIGN_PATH,
        json={
            "expected_revision": 0,
            "event_id": None,
            "proposed_start": None,
            "subject": "Сохранённая тема",
            "body": "Сохранённый текст",
            "text_reviewed": False,
        },
    )
    assert saved.status_code == 200
    response = draft_client.post(
        f"{CAMPAIGN_PATH}/rewrite",
        json={"expected_revision": 1, "instruction": "Сделай короче"},
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ai_not_configured"
    assert draft_client.get(CAMPAIGN_PATH).json() == saved.json()


def test_rewrite_uses_current_saved_fields_but_never_changes_event_or_date(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        payload = json.loads(request.content)
        assert "tools" not in payload
        content = json.loads(payload["messages"][-1]["content"])
        assert content["event_id"] == "ceramics"
        assert content["proposed_start"] == "2099-11-20T19:00:00+03:00"
        assert content["subject"] == "Сохранённая тема"
        return completion(
            json.dumps({"status": "ready", "subject": "Короче", "body": "Новый текст"})
        )

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        old = save_full_draft(client)
        preview = client.post(f"{CAMPAIGN_PATH}/preview", json={"expected_revision": 1})
        assert preview.status_code == 200
        response = client.post(
            f"{CAMPAIGN_PATH}/rewrite",
            json={"expected_revision": 1, "instruction": "Сделай короче"},
        )
        assert response.status_code == 200
        result = response.json()
        assert result["outcome"] == "applied"
        assert result["campaign"]["subject"] == "Короче"
        assert result["campaign"]["body"] == "Новый текст"
        assert result["campaign"]["event_id"] == old["event_id"]
        assert result["campaign"]["proposed_start"] == old["proposed_start"]
        assert result["campaign"]["revision"] == 2
        assert result["campaign"]["text_reviewed"] is False
        assert result["campaign"]["reviewed_event_revision"] is None
        assert result["campaign"]["preview"] is None
        assert calls == 1


@pytest.mark.parametrize(
    ("proposed_start", "canonical", "date", "time", "display"),
    [
        (
            "2099-11-20T20:00:00+03:00",
            "2099-11-20T20:00:00+03:00",
            "20.11.2099",
            "20:00",
            "20.11.2099, 20:00 по Москве",
        ),
        (
            "2100-01-01T01:15:30.125000+03:00",
            "2100-01-01T01:15:30.125000+03:00",
            "01.01.2100",
            "01:15:30.125000",
            "01.01.2100, 01:15:30.125000 по Москве",
        ),
    ],
)
def test_rewrite_receives_authoritative_moscow_facts_instead_of_stale_letter_dates(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    proposed_start: str,
    canonical: str,
    date: str,
    time: str,
    display: str,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        payload = json.loads(request.content)
        assert "tools" not in payload
        system = payload["messages"][0]["content"]
        assert "transfer_facts" in system
        assert "take precedence" in system
        assert "stale" in system
        content = json.loads(payload["messages"][-1]["content"])
        assert content["body"] == "Старое письмо: 20 ноября 2099 года, 19:00"
        assert content["transfer_facts"] == {
            "event_title": "Керамика",
            "timezone": "Europe/Moscow",
            "previous_start": {
                "iso": "2026-11-10T19:00:00+03:00",
                "date": "10.11.2026",
                "time": "19:00",
                "display": "10.11.2026, 19:00 по Москве",
            },
            "new_start": {"iso": canonical, "date": date, "time": time, "display": display},
        }
        return completion(json.dumps({"status": "ready", "subject": "Новая дата", "body": display}))

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        save_full_draft(client)
        changed = client.patch(
            CAMPAIGN_PATH,
            json={
                "expected_revision": 1,
                "event_id": "ceramics",
                "proposed_start": proposed_start,
                "subject": "Старое время: 19:00",
                "body": "Старое письмо: 20 ноября 2099 года, 19:00",
                "text_reviewed": True,
                "reviewed_event_revision": 0,
            },
        )
        assert changed.status_code == 200
        response = client.post(
            f"{CAMPAIGN_PATH}/rewrite",
            json={"expected_revision": 2, "instruction": "Сделайте письмо дружелюбнее"},
        )
        assert response.status_code == 200
        campaign = response.json()["campaign"]
        assert campaign["body"] == display
        assert campaign["proposed_start"] == canonical
        assert campaign["text_reviewed"] is False
        assert campaign["preview"] is None
        assert campaign["phase"] == "draft"
        assert campaign["deliveries"] == []
        assert calls == 1


def test_rewrite_does_not_promote_letter_dates_to_missing_verified_facts(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        content = json.loads(json.loads(request.content)["messages"][-1]["content"])
        assert content["body"] == "Керамика: 20 ноября 2099 года, 19:00"
        assert content["transfer_facts"] == {
            "event_title": None,
            "timezone": "Europe/Moscow",
            "previous_start": None,
            "new_start": None,
        }
        return completion(
            json.dumps({"status": "ready", "subject": "Уведомление", "body": "Проверьте дату"})
        )

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        saved = client.patch(
            CAMPAIGN_PATH,
            json={
                "expected_revision": 0,
                "event_id": None,
                "proposed_start": None,
                "subject": "Старое письмо",
                "body": "Керамика: 20 ноября 2099 года, 19:00",
                "text_reviewed": False,
            },
        )
        assert saved.status_code == 200
        response = client.post(
            f"{CAMPAIGN_PATH}/rewrite",
            json={"expected_revision": 1, "instruction": "Сделайте короче"},
        )
        assert response.status_code == 200
        assert response.json()["campaign"]["event_id"] is None
        assert response.json()["campaign"]["proposed_start"] is None


def test_out_of_scope_does_not_change_revision_or_content(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    with ai_client_factory(
        lambda _request: completion(
            json.dumps({"status": "out_of_scope", "subject": "", "body": ""})
        )
    ) as client:
        create_fixture_draft(client, database_path)
        old = save_full_draft(client)
        response = client.post(
            f"{CAMPAIGN_PATH}/rewrite", json={"expected_revision": 1, "instruction": "Измени дату"}
        )
        assert response.status_code == 200
        assert response.json()["outcome"] == "out_of_scope"
        assert response.json()["campaign"] == old
        assert client.get(CAMPAIGN_PATH).json() == old


@pytest.mark.parametrize("change", ["revision", "phase"])
def test_late_rewrite_does_not_overwrite_new_revision_or_confirmed_campaign(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    change: str,
) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        # This separate connection can write while the network request is active:
        # the AI action must not hold a database transaction during HTTP I/O.
        with connect_db(database_path) as connection:
            if change == "revision":
                connection.execute(
                    "UPDATE campaigns SET subject='Чужая правка',revision=revision+1 WHERE id=?",
                    (CAMPAIGN_PATH.rsplit("/", 1)[1],),
                )
            else:
                connection.execute(
                    "UPDATE campaigns SET phase='confirmed' WHERE id=?",
                    (CAMPAIGN_PATH.rsplit("/", 1)[1],),
                )
        return completion(json.dumps({"status": "ready", "subject": "Поздний", "body": "Поздний"}))

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        save_full_draft(client)
        response = client.post(
            f"{CAMPAIGN_PATH}/rewrite",
            json={"expected_revision": 1, "instruction": "Сделай короче"},
        )
        assert response.status_code == 409
        expected = "revision_conflict" if change == "revision" else "campaign_immutable"
        assert response.json()["detail"]["code"] == expected
        readback = client.get(CAMPAIGN_PATH).json()
        assert readback["subject"] == (
            "Чужая правка" if change == "revision" else "Сохранённая тема"
        )


def test_invalid_rewrite_cannot_smuggle_event_fields_into_draft(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    with ai_client_factory(
        lambda _request: completion(
            json.dumps({"status": "ready", "subject": "A", "body": "B", "event_id": "painting"})
        )
    ) as client:
        create_fixture_draft(client, database_path)
        old = save_full_draft(client)
        response = client.post(
            f"{CAMPAIGN_PATH}/rewrite", json={"expected_revision": 1, "instruction": "Измени текст"}
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert client.get(CAMPAIGN_PATH).json() == old
