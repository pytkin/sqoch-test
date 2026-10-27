"""Explicit preparation intake, deterministic dates and safe application boundaries."""

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from test_ai_prepare import CAMPAIGN_PATH, completion, tool

from sqoch_api.app import create_app
from sqoch_api.notifications.store import connect_db, load_demo

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "demo.json"
NOW = datetime(2026, 10, 27, 9, tzinfo=UTC)


def generated(**changes: object) -> str:
    return json.dumps(
        {
            "status": "ready",
            "event_id": "ceramics",
            "subject": "Перенос",
            "body": "Проверьте новую дату мероприятия.",
            **changes,
        }
    )


def provider(request: httpx.Request) -> httpx.Response:
    payload = json.loads(request.content)
    if "tools" in payload:
        return completion(calls=[tool("get_event_context", {"event_id": "ceramics"})])
    return completion(generated())


@pytest.fixture
def make_ai(database_path: Path, monkeypatch: pytest.MonkeyPatch) -> Callable[..., TestClient]:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fixture-secret-key")

    def make(
        handler: Callable[[httpx.Request], httpx.Response] = provider,
        clock: Callable[[], datetime] = lambda: NOW,
    ) -> TestClient:
        return TestClient(
            create_app(
                frontend_dir=database_path.parent / "missing",
                allowed_hosts=("testserver",),
                clock=clock,
                ai_transport=httpx.MockTransport(handler),
            )
        )

    return make


def initial(client: TestClient, path: Path) -> None:
    load_demo(path, FIXTURE)
    assert client.put(CAMPAIGN_PATH, json={}).status_code == 201


@pytest.mark.parametrize(
    "prompt,expected,source",
    [
        ("Перенести Керамику на 20.11.2027 в 19:00", "2027-11-20T19:00:00+03:00", "explicit"),
        ("Перенести Керамику на 2027-11-20 в 9:05", "2027-11-20T09:05:00+03:00", "explicit"),
        (
            "Перенести Керамику на 20 ноября 2027 года в 19:00",
            "2027-11-20T19:00:00+03:00",
            "explicit",
        ),
        ("Перенести Керамику на 20 ноября в 19:00", "2026-11-20T19:00:00+03:00", "current_year"),
        ("Перенести Керамику на 2027-11-20T16:00:00Z", "2027-11-20T19:00:00+03:00", "explicit"),
    ],
)
def test_complete_date_is_applied_from_input_not_provider(
    make_ai: Callable[..., TestClient],
    database_path: Path,
    prompt: str,
    expected: str,
    source: str,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        old_events = client.get("/api/organizer/events").json()
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": prompt}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["outcome"] == "applied"
        assert data["campaign"]["revision"] == 2
        assert data["campaign"]["proposed_start"] == expected
        assert data["campaign"]["assistant_state"]["year_source"] == source
        assert data["campaign"]["assistant_state"]["intake_revision"] == 1
        assert data["campaign"]["assistant_state"]["applied_revision"] == 2
        assert data["clarifications"] == []
        assert data["campaign"]["text_reviewed"] is False
        assert client.get(CAMPAIGN_PATH).json() == data["campaign"]
        assert client.get("/api/organizer/events").json() == old_events
        assert data["campaign"]["deliveries"] == []


@pytest.mark.parametrize(
    "prompt,field,reason",
    [
        ("Перенести Керамику на 20 сентября в 19:00", "year", "past"),
        ("Перенести Керамику на 20 ноября", "time", "missing"),
        ("Перенести Керамику завтра в 19:00", "date", "ambiguous"),
        ("Перенести с 20.11.2027 на 21.11.2027 в 19:00", "date", "ambiguous"),
        ("Перенести на 31 февраля 2027 в 19:00", "date", "invalid"),
        ("Перенести на 20.11.2027 в 24:00", "time", "invalid"),
        ("Перенести на 20.11.2025 в 19:00", "date", "past"),
        ("Перенести на 10.11.2026 в 19:00", "date", "conflict"),
    ],
)
def test_incomplete_or_unsafe_date_returns_targeted_question(
    make_ai: Callable[..., TestClient],
    database_path: Path,
    prompt: str,
    field: str,
    reason: str,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": prompt}
        )
        assert response.status_code == 200
        assert response.json()["outcome"] == "needs_input"
        assert {"field": field, "reason": reason, "candidate_event_id": None} in response.json()[
            "clarifications"
        ]
        assert response.json()["campaign"]["proposed_start"] is None


def test_provider_failure_persists_new_intake_but_keeps_previous_ready_fields(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    def unavailable(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("provider-secret")

    with make_ai(unavailable) as client:
        initial(client, database_path)
        before = client.patch(
            CAMPAIGN_PATH,
            json={
                "expected_revision": 0,
                "event_id": "ceramics",
                "proposed_start": "2099-11-20T19:00:00+03:00",
                "subject": "Сохранённая тема",
                "body": "Сохранённый текст",
                "text_reviewed": False,
                "mode": "manual",
            },
        ).json()
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 1, "prompt": "Перенести на 21.11.2099 в 20:00"},
        )
        assert response.status_code == 502
        after = client.get(CAMPAIGN_PATH).json()
        assert after["revision"] == 2
        for field in ("event_id", "proposed_start", "subject", "body"):
            assert after[field] == before[field]
        assert after["assistant_state"]["stage"] == "failed"
        assert after["assistant_state"]["mode"] == "assistant"
        assert after["assistant_state"]["original_prompt"] == "Перенести на 21.11.2099 в 20:00"
        assert "provider-secret" not in response.text


def test_structured_year_answer_restores_original_components(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        first = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику на 20 сентября в 19:00"},
        )
        assert first.status_code == 200
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={
                "expected_revision": first.json()["campaign"]["revision"],
                "answers": {"year": 2027},
            },
        )
        assert response.status_code == 200
        assert response.json()["outcome"] == "applied"
        assert response.json()["campaign"]["proposed_start"] == "2027-09-20T19:00:00+03:00"
        state = response.json()["campaign"]["assistant_state"]
        assert state["original_prompt"] == "Перенести Керамику на 20 сентября в 19:00"
        assert state["year_source"] == "clarification"


def test_model_cannot_supply_structured_date(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    def smuggled(request: httpx.Request) -> httpx.Response:
        if "tools" in json.loads(request.content):
            return provider(request)
        return completion(generated(proposed_start="2099-11-20T19:00:00+03:00"))

    with make_ai(smuggled) as client:
        initial(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику"},
        )
        assert response.status_code == 502
        assert client.get(CAMPAIGN_PATH).json()["proposed_start"] is None
        assert client.get(CAMPAIGN_PATH).json()["assistant_state"]["stage"] == "failed"


def test_current_year_requires_matching_event_year_and_explicit_year_wins(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        with connect_db(database_path) as connection:
            connection.execute(
                "UPDATE events SET starts_at_utc='2027-11-10T16:00:00Z' WHERE id='ceramics'"
            )
        first = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику на 20 ноября в 19:00"},
        )
        assert first.status_code == 200
        assert first.json()["clarifications"] == [
            {"field": "year", "reason": "conflict", "candidate_event_id": None}
        ]
        assert first.json()["campaign"]["assistant_state"]["partial_date"]["year"] is None
        explicit = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 2, "answers": {"year": 2026}}
        )
        assert explicit.status_code == 200
        assert explicit.json()["campaign"]["proposed_start"] == "2026-11-20T19:00:00+03:00"


def test_default_year_uses_moscow_clock_not_utc_year(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai(clock=lambda: datetime(2026, 12, 31, 22, tzinfo=UTC)) as client:
        initial(client, database_path)
        with connect_db(database_path) as connection:
            connection.execute(
                "UPDATE events SET starts_at_utc='2027-01-02T16:00:00Z' WHERE id='ceramics'"
            )
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику на 10 января в 19:00"},
        )
        assert response.status_code == 200
        assert response.json()["campaign"]["proposed_start"] == "2027-01-10T19:00:00+03:00"


def test_default_year_survives_reload_and_retry_does_not_silently_advance_it(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    now = [NOW]
    with make_ai(clock=lambda: now[0]) as client:
        initial(client, database_path)
        prepared = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику на 20 ноября в 19:00"},
        )
        assert prepared.status_code == 200
        saved = prepared.json()["campaign"]
    now[0] = datetime(2027, 1, 1, tzinfo=UTC)
    with make_ai(clock=lambda: now[0]) as restarted:
        assert restarted.get(CAMPAIGN_PATH).json() == saved
        retry = restarted.post(f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 2})
        assert retry.status_code == 200
        assert retry.json()["outcome"] == "needs_input"
        assert retry.json()["clarifications"] == [
            {"field": "year", "reason": "past", "candidate_event_id": None}
        ]
        assert retry.json()["campaign"]["assistant_state"]["partial_date"]["year"] == 2026


@pytest.mark.parametrize("selection", ["answer", "manual"])
def test_saved_default_year_requires_clarification_after_accepted_event_switch(
    make_ai: Callable[..., TestClient],
    database_path: Path,
    selection: str,
) -> None:
    selected = ["ceramics"]

    def selected_provider(request: httpx.Request) -> httpx.Response:
        if "tools" in json.loads(request.content):
            return completion(calls=[tool("get_event_context", {"event_id": selected[0]})])
        return completion(generated(event_id=selected[0]))

    with make_ai(selected_provider) as client:
        initial(client, database_path)
        with connect_db(database_path) as connection:
            connection.execute(
                "UPDATE events SET starts_at_utc='2027-11-10T16:00:00Z' WHERE id='painting'"
            )
        first = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести на 20 ноября в 19:00"},
        )
        assert first.status_code == 200
        assert first.json()["outcome"] == "applied"
        saved = first.json()["campaign"]
        assert saved["assistant_state"]["year_source"] == "current_year"
        assert client.get(CAMPAIGN_PATH).json() == saved
        selected[0] = "painting"
        answers: dict[str, object] = {"event_id": "painting"}
        if selection == "manual":
            patched = client.patch(
                CAMPAIGN_PATH,
                json={
                    "expected_revision": saved["revision"],
                    "event_id": "painting",
                    "proposed_start": saved["proposed_start"],
                    "subject": saved["subject"],
                    "body": saved["body"],
                    "text_reviewed": False,
                    "mode": "manual",
                    "manual_fields": ["event_id"],
                },
            )
            assert patched.status_code == 200
            saved = patched.json()
            assert saved["assistant_state"]["manual_fields"] == ["event_id"]
            assert saved["assistant_state"]["year_source"] == "current_year"
            answers = {}
        switched = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": saved["revision"], "answers": answers},
        )
        assert switched.status_code == 200
        assert switched.json()["outcome"] == "needs_input"
        assert switched.json()["clarifications"] == [
            {"field": "year", "reason": "conflict", "candidate_event_id": None}
        ]
        campaign = switched.json()["campaign"]
        assert campaign["event_id"] == "painting"
        assert campaign["assistant_state"]["partial_date"] == {
            "year": 2026,
            "month": 11,
            "day": 20,
            "hour": 19,
            "minute": 0,
        }
        assert campaign["assistant_state"]["manual_fields"] == (
            ["event_id"] if selection == "manual" else []
        )
        assert client.get(CAMPAIGN_PATH).json() == campaign
        corrected = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": campaign["revision"], "answers": {"year": 2027}},
        )
        assert corrected.status_code == 200
        assert corrected.json()["outcome"] == "applied"
        assert corrected.json()["campaign"]["proposed_start"] == "2027-11-20T19:00:00+03:00"
        assert corrected.json()["campaign"]["assistant_state"]["year_source"] == "clarification"


def test_saved_default_year_retry_in_same_context_preserves_applied_date(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        first = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести на 20 ноября в 19:00"},
        )
        assert first.status_code == 200
        retried = client.post(f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 2})
        assert retried.status_code == 200
        assert retried.json()["outcome"] == "applied"
        assert (
            retried.json()["campaign"]["proposed_start"]
            == first.json()["campaign"]["proposed_start"]
        )
        assert retried.json()["campaign"]["assistant_state"]["year_source"] == "current_year"


def test_resolved_date_is_in_readonly_tool_facts_before_text_generation(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    def inspect(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        if "tools" not in payload:
            fact = next(
                json.loads(message["content"])
                for message in payload["messages"]
                if message["role"] == "tool"
            )
            assert fact["transfer"]["proposed_start"] == "2027-11-20T19:00:00+03:00"
            assert "a@example.com" not in request.content.decode()
        return provider(request)

    with make_ai(inspect) as client:
        initial(client, database_path)
        assert (
            client.post(
                f"{CAMPAIGN_PATH}/prepare",
                json={"expected_revision": 0, "prompt": "Перенести Керамику на 20.11.2027 в 19:00"},
            ).status_code
            == 200
        )


def test_pinned_event_switch_requires_explicit_answer_and_keeps_original_prompt(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    def painting(request: httpx.Request) -> httpx.Response:
        if "tools" in json.loads(request.content):
            return completion(calls=[tool("get_event_context", {"event_id": "painting"})])
        return completion(generated(event_id="painting"))

    with make_ai(painting) as client:
        initial(client, database_path)
        saved = client.patch(
            CAMPAIGN_PATH,
            json={
                "expected_revision": 0,
                "event_id": "ceramics",
                "proposed_start": None,
                "subject": "Сохранённая тема",
                "body": "Сохранённый текст",
                "text_reviewed": False,
                "manual_fields": ["event_id"],
            },
        )
        assert saved.status_code == 200
        first = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 1, "prompt": "Перенести Живопись на 20.11.2027 в 19:00"},
        )
        assert first.status_code == 200
        assert first.json()["campaign"]["event_id"] == "ceramics"
        assert {
            "field": "event_id",
            "reason": "conflict",
            "candidate_event_id": "painting",
        } in first.json()["clarifications"]
        accepted = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 3, "answers": {"event_id": "painting"}},
        )
        assert accepted.status_code == 200
        assert accepted.json()["outcome"] == "applied"
        assert accepted.json()["campaign"]["event_id"] == "painting"
        assert (
            accepted.json()["campaign"]["assistant_state"]["original_prompt"]
            == "Перенести Живопись на 20.11.2027 в 19:00"
        )


@pytest.mark.parametrize(
    "answers",
    [
        {"year": True},
        {"year": 0},
        {"date": "2027-02-30"},
        {"time": "24:00"},
        {"event_id": None},
        {"extra": "forbidden"},
    ],
)
def test_invalid_answers_are_rejected_before_intake(
    make_ai: Callable[..., TestClient],
    database_path: Path,
    answers: dict[str, object],
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        before = client.get(CAMPAIGN_PATH).json()
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "answers": answers}
        )
        assert response.status_code == 422
        assert client.get(CAMPAIGN_PATH).json() == before


def test_late_failure_cannot_mark_newer_preparation_failed(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    def late(_request: httpx.Request) -> httpx.Response:
        with connect_db(database_path) as connection:
            row = connection.execute("SELECT assistant_state_json FROM campaigns").fetchone()
            state = json.loads(row[0])
            assert state["stage"] == "intake"
            state["stage"] = "applied"
            state["original_prompt"] = "Новое сохранённое действие"
            connection.execute(
                "UPDATE campaigns SET revision=revision+1,assistant_state_json=?",
                (json.dumps(state),),
            )
        raise httpx.ConnectError("late")

    with make_ai(late) as client:
        initial(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести на 20.11.2027 в 19:00"},
        )
        assert response.status_code == 502
        after = client.get(CAMPAIGN_PATH).json()
        assert after["revision"] == 2
        assert after["assistant_state"]["stage"] == "applied"
        assert after["assistant_state"]["original_prompt"] == "Новое сохранённое действие"


def test_event_change_during_generation_requires_new_context_without_applying_text(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    def changed(request: httpx.Request) -> httpx.Response:
        if "tools" in json.loads(request.content):
            return provider(request)
        with connect_db(database_path) as connection:
            connection.execute("UPDATE events SET revision=revision+1 WHERE id='ceramics'")
        return completion(generated())

    with make_ai(changed) as client:
        initial(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику на 20.11.2027 в 19:00"},
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "text_review_required"
        after = client.get(CAMPAIGN_PATH).json()
        assert after["revision"] == 1
        assert after["subject"] == after["body"] == ""
        assert after["assistant_state"]["stage"] == "failed"


def test_manual_date_time_win_until_explicit_clarification_answers(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        saved = client.patch(
            CAMPAIGN_PATH,
            json={
                "expected_revision": 0,
                "event_id": "ceramics",
                "proposed_start": "2099-11-20T19:00:00+03:00",
                "subject": "Тема",
                "body": "Текст",
                "text_reviewed": False,
                "mode": "manual",
            },
        )
        assert saved.status_code == 200
        conflict = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 1, "prompt": "Перенести Керамику на 21.11.2099 в 20:00"},
        )
        assert conflict.status_code == 200
        assert conflict.json()["outcome"] == "needs_input"
        assert conflict.json()["campaign"]["proposed_start"] == "2099-11-20T19:00:00+03:00"
        assert {(item["field"], item["reason"]) for item in conflict.json()["clarifications"]} == {
            ("date", "conflict"),
            ("time", "conflict"),
        }
        accepted = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 3, "answers": {"date": "2099-11-21", "time": "20:00"}},
        )
        assert accepted.status_code == 200
        assert accepted.json()["outcome"] == "applied"
        assert accepted.json()["campaign"]["proposed_start"] == "2099-11-21T20:00:00+03:00"


def test_autofilled_transfer_still_requires_human_review_before_preview(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        prepared = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику на 20.11.2027 в 19:00"},
        )
        assert prepared.status_code == 200
        preview = client.post(f"{CAMPAIGN_PATH}/preview", json={"expected_revision": 2})
        assert preview.status_code == 409
        assert preview.json()["detail"]["code"] == "text_review_required"
        assert client.get(CAMPAIGN_PATH).json()["deliveries"] == []


def test_new_complete_date_answer_replaces_old_year_answer(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        first = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={
                "expected_revision": 0,
                "prompt": "Перенести Керамику на 20 сентября в 19:00",
                "answers": {"year": 2027},
            },
        )
        assert first.status_code == 200
        replaced = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 2, "answers": {"date": "2028-09-21"}},
        )
        assert replaced.status_code == 200
        assert replaced.json()["campaign"]["proposed_start"] == "2028-09-21T19:00:00+03:00"


def test_conflicting_year_and_date_in_one_answer_reject_before_intake(
    make_ai: Callable[..., TestClient],
    database_path: Path,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        original = client.get(CAMPAIGN_PATH).json()
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={
                "expected_revision": 0,
                "prompt": "Перенести занятие",
                "answers": {"year": 2027, "date": "2028-09-21"},
            },
        )
        assert response.status_code == 422
        assert client.get(CAMPAIGN_PATH).json() == original


@pytest.mark.parametrize(
    "answers,expected",
    [
        ({"year": 2027}, "2027-12-02T19:00:00+03:00"),
        ({"date": "2027-12-03"}, "2027-12-03T19:00:00+03:00"),
    ],
)
def test_explicit_answer_clears_only_the_corrected_invalid_year(
    make_ai: Callable[..., TestClient],
    database_path: Path,
    answers: dict[str, object],
    expected: str,
) -> None:
    with make_ai() as client:
        initial(client, database_path)
        first = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Перенести Керамику на 2 декабря 26, 19:00"},
        )
        assert first.status_code == 200
        assert first.json()["clarifications"] == [
            {"field": "year", "reason": "invalid", "candidate_event_id": None}
        ]
        corrected = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 2, "answers": answers}
        )
        assert corrected.status_code == 200
        assert corrected.json()["outcome"] == "applied"
        assert corrected.json()["campaign"]["proposed_start"] == expected
