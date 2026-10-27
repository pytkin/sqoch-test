"""Persistent preparation drafts through real HTTP and isolated SQLite files."""

import json
import shutil
import sqlite3
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sqoch_api.app import create_app
from sqoch_api.notifications.assistant_state import AssistantAnswers
from sqoch_api.notifications.service import get_campaign, list_campaigns
from sqoch_api.notifications.store import MIGRATIONS_DIR, connect_db, init_db, load_demo
from sqoch_api.orders import StrictModel

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "demo.json"
FUTURE = "2099-11-20T19:00:00+03:00"


def campaign_path() -> str:
    return f"/api/organizer/campaigns/{uuid4()}"


def edit(revision: int = 0, **changes: object) -> dict[str, object]:
    return {
        "expected_revision": revision,
        "event_id": None,
        "proposed_start": None,
        "subject": "",
        "body": "",
        "text_reviewed": False,
        **changes,
    }


def manual(**changes: object) -> dict[str, object]:
    return {
        "mode": "manual",
        "event_id": "ceramics",
        "proposed_start": FUTURE,
        "subject": "Перенос занятия",
        "body": "Новая дата занятия указана в переносе.",
        "manual_fields": ["event_id", "date", "time"],
        **changes,
    }


def test_legacy_empty_create_still_works(draft_client: TestClient) -> None:
    response = draft_client.put(campaign_path(), json={})
    assert response.status_code == 201
    assert response.json()["revision"] == 0
    assert response.json()["event_id"] is None


def test_meaningful_assistant_create_persists_input_and_event_without_side_effects(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    events = draft_client.get("/api/organizer/events").json()
    path = campaign_path()
    created = draft_client.put(
        path,
        json={
            "prompt": "  Перенести Керамику на 20 ноября 2099 в 19:00  ",
            "context_event_id": "ceramics",
        },
    )
    assert created.status_code == 201
    data = created.json()
    assert data["revision"] == 0
    assert data["event_id"] == "ceramics"
    assert data["proposed_start"] is None
    state = data["assistant_state"]
    assert state["original_prompt"] == "Перенести Керамику на 20 ноября 2099 в 19:00"
    assert (state["mode"], state["stage"], state["intake_revision"], state["applied_revision"]) == (
        "assistant",
        "intake",
        0,
        None,
    )
    assert state["context_event_id"] == "ceramics"
    assert state["answers"] == {}
    assert state["manual_fields"] == []
    assert draft_client.get(path).json() == data
    summary = draft_client.get("/api/organizer/campaigns").json()["items"][0]
    assert summary["has_content"] is True
    assert summary["event_id"] == "ceramics"
    assert summary["preparation_stage"] == "intake"
    assert summary["event_snapshot"] is None
    assert draft_client.get("/api/organizer/events").json() == events
    with connect_db(database_path) as connection:
        assert connection.execute("SELECT count(*) FROM deliveries").fetchone()[0] == 0


@pytest.mark.parametrize("unknown_field", ["event_id", "context_event_id"])
def test_unknown_create_event_rejects_without_partial_insert(
    draft_client: TestClient,
    unknown_field: str,
) -> None:
    path = campaign_path()
    response = draft_client.put(
        path, json={"prompt": "Перенести занятие", unknown_field: "missing"}
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "not_found"
    assert draft_client.get(path).status_code == 404


def test_conflicting_create_context_rejects_without_insert(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    response = draft_client.put(
        path,
        json={
            "prompt": "Перенести занятие",
            "event_id": "painting",
            "context_event_id": "ceramics",
        },
    )
    assert response.status_code == 422
    assert draft_client.get(path).status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"prompt": ""},
        {"prompt": "  "},
        {"prompt": None},
        {"prompt": True},
        {"mode": "chat"},
        {"manual_fields": ["event_id", "event_id"]},
        {"manual_fields": ["subject"]},
        {"manual_fields": [True]},
        {"proposed_start": "2099-11-20T19:00:00Z"},
    ],
)
def test_invalid_create_values_are_rejected_without_insert(
    draft_client: TestClient,
    payload: dict[str, object],
) -> None:
    path = campaign_path()
    response = draft_client.put(path, json=payload)
    assert response.status_code == 422
    assert draft_client.get(path).status_code == 404


@pytest.mark.parametrize("complete", [False, True])
def test_manual_create_persists_fields_and_provenance(
    draft_client: TestClient,
    database_path: Path,
    complete: bool,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    response = draft_client.put(path, json=manual(body="Текст" if complete else ""))
    assert response.status_code == 201
    data = response.json()
    assert data["proposed_start"] == FUTURE
    state = data["assistant_state"]
    assert state["mode"] == "manual"
    assert state["stage"] == ("applied" if complete else "needs_input")
    assert state["manual_fields"] == ["event_id", "date", "time"]
    assert state["partial_date"] == {"year": 2099, "month": 11, "day": 20, "hour": 19, "minute": 0}
    assert state["original_prompt"] == ""
    assert state["intake_revision"] is None
    assert state["applied_revision"] == (0 if complete else None)


@pytest.mark.parametrize("confirmed", [False, True])
def test_repeat_meaningful_put_preserves_existing_even_with_unknown_new_context(
    draft_client: TestClient,
    database_path: Path,
    confirmed: bool,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    first = draft_client.put(path, json=manual())
    assert first.status_code == 201
    if confirmed:
        saved = draft_client.patch(
            path,
            json=edit(
                event_id="ceramics",
                proposed_start=FUTURE,
                subject="Перенос",
                body="Текст",
                text_reviewed=True,
                reviewed_event_revision=0,
            ),
        )
        assert saved.status_code == 200
        preview = draft_client.post(f"{path}/preview", json={"expected_revision": 1})
        assert preview.status_code == 200
        first = draft_client.post(
            f"{path}/confirm", json={"preview_token": preview.json()["token"]}
        )
        assert first.status_code == 202
    repeated = draft_client.put(
        path, json={"prompt": "Другой запрос", "context_event_id": "missing"}
    )
    assert repeated.status_code == 200
    assert repeated.json() == first.json()


def test_text_only_manual_mode_and_no_mode_save_survive_restart(database_path: Path) -> None:
    path = campaign_path()
    with TestClient(
        create_app(frontend_dir=database_path.parent / "missing", allowed_hosts=("testserver",))
    ) as client:
        created = client.put(path, json={"prompt": "Перенести занятие"})
        assert created.status_code == 201
        untouched = client.patch(path, json=edit(manual_fields=[]))
        assert untouched.status_code == 200
        assert untouched.json()["assistant_state"]["mode"] == "assistant"
        changed = client.patch(
            path, json=edit(1, mode="manual", body="Ручной текст", manual_fields=[])
        )
        assert changed.status_code == 200
        assert changed.json()["assistant_state"]["mode"] == "manual"
        assert changed.json()["assistant_state"]["original_prompt"] == "Перенести занятие"
        saved = changed.json()
    with TestClient(
        create_app(frontend_dir=database_path.parent / "missing", allowed_hosts=("testserver",))
    ) as restarted:
        assert restarted.get(path).json() == saved


def test_manual_save_persists_new_prompt_after_failed_prepare_and_restart(
    database_path: Path,
) -> None:
    path = campaign_path()
    with TestClient(
        create_app(frontend_dir=database_path.parent / "missing", allowed_hosts=("testserver",))
    ) as client:
        created = client.put(path, json={"prompt": "Первый запрос A"})
        assert created.status_code == 201
        failed = client.post(f"{path}/prepare", json={"expected_revision": 0})
        assert failed.status_code == 503
        saved = client.patch(
            path,
            json=edit(
                1, mode="manual", prompt="  Новый запрос B  ", body="Ручной текст", manual_fields=[]
            ),
        )
        assert saved.status_code == 200
        expected = saved.json()
        assert expected["assistant_state"]["mode"] == "manual"
        assert expected["assistant_state"]["original_prompt"] == "Новый запрос B"
        assert expected["assistant_state"]["manual_fields"] == []
        with connect_db(database_path) as connection:
            assert (
                connection.execute(
                    "SELECT prompt FROM campaigns WHERE id=?", (path.rsplit("/", 1)[1],)
                ).fetchone()[0]
                == "Новый запрос B"
            )
    with TestClient(
        create_app(frontend_dir=database_path.parent / "missing", allowed_hosts=("testserver",))
    ) as restarted:
        assert restarted.get(path).json() == expected


def test_omitted_prompt_retains_previous_input_and_stale_new_prompt_cannot_overwrite(
    draft_client: TestClient,
) -> None:
    path = campaign_path()
    assert draft_client.put(path, json={"prompt": "Сохранённый A"}).status_code == 201
    unchanged = draft_client.patch(path, json=edit(mode="manual", body="Текст", manual_fields=[]))
    assert unchanged.status_code == 200
    assert unchanged.json()["assistant_state"]["original_prompt"] == "Сохранённый A"
    changed = draft_client.patch(
        path, json=edit(1, mode="manual", body="Текст", prompt="Новый B", manual_fields=[])
    )
    assert changed.status_code == 200
    stale = draft_client.patch(path, json=edit(1, mode="manual", prompt="Устаревший C"))
    assert stale.status_code == 409
    assert draft_client.get(path).json() == changed.json()


def test_stale_saved_prompt_rejects_without_overwriting_input(draft_client: TestClient) -> None:
    path = campaign_path()
    assert draft_client.put(path, json={"prompt": "Сохранённый A"}).status_code == 201
    saved = draft_client.patch(path, json=edit(mode="manual", body="Текст", manual_fields=[]))
    assert saved.status_code == 200
    stale = draft_client.patch(path, json=edit(prompt="Устаревший B", mode="manual"))
    assert stale.status_code == 409
    assert draft_client.get(path).json() == saved.json()


def test_new_saved_prompt_resets_old_answers_without_promoting_untouched_ai_fields(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    created = draft_client.put(path, json={"prompt": "Запрос A", "context_event_id": "ceramics"})
    assert created.status_code == 201
    state = created.json()["assistant_state"]
    state["answers"] = {"year": 2027}
    state["partial_date"] = {"year": 2027, "month": 11, "day": 20, "hour": 19, "minute": 0}
    state["year_source"] = "clarification"
    with connect_db(database_path) as connection:
        connection.execute(
            "UPDATE campaigns SET assistant_state_json=?,proposed_start=? WHERE id=?",
            (json.dumps(state), FUTURE, path.rsplit("/", 1)[1]),
        )
    saved = draft_client.patch(
        path,
        json=edit(
            mode="manual",
            event_id="ceramics",
            proposed_start=FUTURE,
            subject="Тема",
            body="Текст",
            prompt="Запрос B",
            manual_fields=[],
        ),
    )
    assert saved.status_code == 200
    updated = saved.json()["assistant_state"]
    assert updated["original_prompt"] == "Запрос B"
    assert updated["answers"] == {}
    assert updated["partial_date"] == {
        "year": None,
        "month": None,
        "day": None,
        "hour": None,
        "minute": None,
    }
    assert updated["year_source"] is None
    assert updated["manual_fields"] == []
    assert saved.json()["proposed_start"] == FUTURE


@pytest.mark.parametrize("prompt", [None, True, [], "x" * 4001])
def test_invalid_saved_prompt_is_rejected_without_changing_draft(
    draft_client: TestClient,
    prompt: object,
) -> None:
    path = campaign_path()
    original = draft_client.put(path, json={"prompt": "Сохранённый A"}).json()
    response = draft_client.patch(path, json=edit(prompt=prompt))
    assert response.status_code == 422
    assert draft_client.get(path).json() == original


@pytest.mark.parametrize("prompt", ["", "   "])
def test_manual_save_can_explicitly_clear_saved_prompt_and_restore_empty(
    draft_client: TestClient,
    database_path: Path,
    prompt: str,
) -> None:
    path = campaign_path()
    assert draft_client.put(path, json={"prompt": "Сохранённый A"}).status_code == 201
    saved = draft_client.patch(path, json=edit(mode="manual", prompt=prompt, manual_fields=[]))
    assert saved.status_code == 200
    assert saved.json()["assistant_state"]["original_prompt"] == ""
    assert saved.json()["assistant_state"]["mode"] == "manual"
    with TestClient(
        create_app(frontend_dir=database_path.parent / "missing", allowed_hosts=("testserver",))
    ) as restarted:
        assert restarted.get(path).json() == saved.json()
    with connect_db(database_path) as connection:
        assert (
            connection.execute(
                "SELECT prompt FROM campaigns WHERE id=?", (path.rsplit("/", 1)[1],)
            ).fetchone()[0]
            == ""
        )


def test_legacy_manual_save_and_explicit_empty_provenance_do_not_erase_origins(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    assert draft_client.put(path, json={}).status_code == 201
    saved = draft_client.patch(
        path,
        json=edit(
            event_id="ceramics",
            proposed_start=FUTURE,
            subject="Тема",
            body="Текст",
        ),
    )
    assert saved.status_code == 200
    state = saved.json().get("assistant_state")
    assert state is not None
    assert state["manual_fields"] == ["event_id", "date", "time"]
    repeated = draft_client.patch(
        path,
        json=edit(
            1,
            event_id="ceramics",
            proposed_start=FUTURE,
            subject="Тема",
            body="Текст",
            manual_fields=[],
        ),
    )
    assert repeated.status_code == 200
    assert repeated.json()["assistant_state"]["manual_fields"] == state["manual_fields"]
    stale = draft_client.patch(path, json=edit(mode="assistant", manual_fields=[]))
    assert stale.status_code == 409
    assert draft_client.get(path).json() == repeated.json()


def test_legacy_summary_content_uses_every_existing_content_source(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    paths = [campaign_path() for _ in range(7)]
    for path in paths:
        assert draft_client.put(path, json={}).status_code == 201
    fields = ["prompt", "event_id", "proposed_start", "subject", "body", "suggested_start"]
    values = ["Перенос", "ceramics", FUTURE, "Тема", "Текст", FUTURE]
    with connect_db(database_path) as connection:
        for path, field, value in zip(paths, fields, values, strict=False):
            connection.execute(
                f"UPDATE campaigns SET {field}=? WHERE id=?", (value, path.rsplit("/", 1)[1])
            )
    items = {
        item["id"]: item for item in draft_client.get("/api/organizer/campaigns").json()["items"]
    }
    for path in paths[:-1]:
        item = items[path.rsplit("/", 1)[1]]
        assert item.get("has_content") is True
        assert item["preparation_stage"] == "manual"
        assert item["event_snapshot"] is None
    empty = items[paths[-1].rsplit("/", 1)[1]]
    assert empty.get("has_content") is False
    assert empty["preparation_stage"] == "empty"


def test_answer_serialization_keeps_typed_openapi_properties_without_nullable_inputs() -> None:
    output = create_app().openapi()["components"]["schemas"]["AnswersOutput"]
    assert set(output["properties"]) == {"event_id", "year", "date", "time"}
    assert not output.get("required")
    assert AssistantAnswers().model_dump(mode="json") == {}
    assert AssistantAnswers(year=2027).model_dump(mode="json") == {"year": 2027}
    assert output["properties"]["year"]["type"] == "integer"
    for field in ("event_id", "date", "time"):
        assert output["properties"][field]["type"] == "string"
    validation = AssistantAnswers.model_json_schema(mode="validation")
    for field, expected in (
        ("event_id", "string"),
        ("year", "integer"),
        ("date", "string"),
        ("time", "string"),
    ):
        assert validation["properties"][field]["type"] == expected
        assert "anyOf" not in validation["properties"][field]


def test_partial_answer_output_stays_optional_inside_strict_response_parent() -> None:
    class StrictAnswersResponse(StrictModel):
        answers: AssistantAnswers

    output = StrictAnswersResponse.model_json_schema(mode="serialization")["$defs"]["AnswersOutput"]
    assert not output.get("required")
    assert output["additionalProperties"] is False
    assert StrictAnswersResponse(answers=AssistantAnswers()).model_dump(mode="json") == {
        "answers": {}
    }
    assert StrictAnswersResponse(answers=AssistantAnswers(year=2027)).model_dump(mode="json") == {
        "answers": {"year": 2027}
    }
    for invalid in ({"year": None}, {"event_id": None}, {"extra": "forbidden"}):
        with pytest.raises(ValidationError):
            AssistantAnswers.model_validate(invalid)


def test_clearing_only_manual_date_preserves_known_time(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    assert draft_client.put(path, json=manual()).status_code == 201
    cleared = draft_client.patch(
        path,
        json=edit(
            event_id="ceramics",
            proposed_start=None,
            subject="Перенос",
            body="Текст",
            mode="manual",
            manual_fields=["date"],
        ),
    )
    assert cleared.status_code == 200
    state = cleared.json()["assistant_state"]
    assert state["partial_date"] == {
        "year": None,
        "month": None,
        "day": None,
        "hour": 19,
        "minute": 0,
    }
    assert state["stage"] == "needs_input"


def test_review_completed_manual_draft_clears_old_clarifications(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    created = draft_client.put(path, json={"mode": "manual", "subject": "Тема", "body": "Текст"})
    assert created.status_code == 201
    assert created.json()["assistant_state"]["stage"] == "needs_input"
    assert created.json()["assistant_state"]["clarifications"]
    saved = draft_client.patch(
        path,
        json=edit(
            event_id="ceramics",
            proposed_start=FUTURE,
            subject="Тема",
            body="Текст",
            mode="manual",
            manual_fields=["event_id", "date", "time"],
        ),
    )
    assert saved.status_code == 200
    state = saved.json()["assistant_state"]
    assert state["stage"] == "applied"
    assert state["clarifications"] == []
    assert draft_client.get(path).json()["assistant_state"] == state


def test_review_clearing_only_time_asks_only_time(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    assert draft_client.put(path, json=manual()).status_code == 201
    cleared = draft_client.patch(
        path,
        json=edit(
            event_id="ceramics",
            proposed_start=None,
            subject="Тема",
            body="Текст",
            mode="manual",
            manual_fields=["time"],
        ),
    )
    assert cleared.status_code == 200
    state = cleared.json()["assistant_state"]
    assert state["partial_date"] == {
        "year": 2099,
        "month": 11,
        "day": 20,
        "hour": None,
        "minute": None,
    }
    assert state["clarifications"] == [
        {"field": "time", "reason": "missing", "candidate_event_id": None}
    ]
    assert draft_client.get(path).json()["assistant_state"] == state


def pending_assistant(
    client: TestClient,
    database_path: Path,
    partial: dict[str, object],
    clarification: dict[str, object],
) -> tuple[str, dict[str, object]]:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    created = client.put(
        path, json={"prompt": "Переносим Керамику на 2 декабря", "context_event_id": "ceramics"}
    )
    assert created.status_code == 201
    state = dict(created.json()["assistant_state"])
    state.update(
        stage="needs_input",
        partial_date=partial,
        clarifications=[clarification],
        intake_revision=1,
    )
    with connect_db(database_path) as connection:
        connection.execute(
            "UPDATE campaigns SET revision=2,assistant_state_json=? WHERE id=?",
            (json.dumps(state), path.rsplit("/", 1)[1]),
        )
    assert client.get(path).json()["assistant_state"] == state
    return path, state


@pytest.mark.parametrize("include_prompt", [False, True])
@pytest.mark.parametrize(
    ("partial", "clarification"),
    [
        (
            {"year": None, "month": 12, "day": 2, "hour": None, "minute": None},
            {"field": "time", "reason": "missing", "candidate_event_id": None},
        ),
        (
            {"year": 2026, "month": 12, "day": 2, "hour": 18, "minute": 30},
            {"field": "event_id", "reason": "conflict", "candidate_event_id": "painting"},
        ),
        (
            {"year": None, "month": 9, "day": 20, "hour": 19, "minute": 0},
            {"field": "year", "reason": "past", "candidate_event_id": None},
        ),
    ],
)
def test_unchanged_assistant_save_preserves_targeted_clarifications(
    draft_client: TestClient,
    database_path: Path,
    partial: dict[str, object],
    clarification: dict[str, object],
    include_prompt: bool,
) -> None:
    path, before = pending_assistant(draft_client, database_path, partial, clarification)
    payload = edit(2, event_id="ceramics", mode="assistant", manual_fields=[])
    if include_prompt:
        payload["prompt"] = before["original_prompt"]
    response = draft_client.patch(path, json=payload)
    assert response.status_code == 200
    saved = response.json()
    assert saved["revision"] == 3
    assert saved["assistant_state"] == before
    assert saved["text_reviewed"] is False
    assert saved["preview"] is None
    assert saved["deliveries"] == []
    assert draft_client.get(path).json() == saved
    stale = draft_client.patch(path, json=payload)
    assert stale.status_code == 409
    assert draft_client.get(path).json() == saved


@pytest.mark.parametrize(
    ("changes", "stage", "questions"),
    [
        ({"proposed_start": FUTURE, "manual_fields": ["date", "time"]}, "needs_input", []),
        ({"event_id": "painting", "manual_fields": ["event_id"]}, "needs_input", []),
        ({"mode": "manual"}, "needs_input", []),
        ({"prompt": "Другой запрос: переносим на 3 декабря"}, "intake", []),
        (
            {"manual_fields": ["date"]},
            "needs_input",
            [{"field": "date", "reason": "missing", "candidate_event_id": None}],
        ),
    ],
)
def test_changed_context_or_manual_edit_does_not_preserve_old_assistant_questions(
    draft_client: TestClient,
    database_path: Path,
    changes: dict[str, object],
    stage: str,
    questions: list[dict[str, object]],
) -> None:
    path, _before = pending_assistant(
        draft_client,
        database_path,
        {"year": 2026, "month": 12, "day": 2, "hour": 18, "minute": 30},
        {"field": "event_id", "reason": "conflict", "candidate_event_id": "painting"},
    )
    payload = edit(2, event_id="ceramics", mode="assistant", manual_fields=[])
    payload.update(changes)
    response = draft_client.patch(path, json=payload)
    assert response.status_code == 200
    state = response.json()["assistant_state"]
    assert state["stage"] == stage
    assert state["clarifications"] == questions
    assert draft_client.get(path).json()["assistant_state"] == state


def test_manual_changes_replace_stale_partial_answers_and_pin_new_event(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    load_demo(database_path, FIXTURE)
    path = campaign_path()
    created = draft_client.put(
        path, json={"prompt": "Старый запрос", "context_event_id": "ceramics"}
    )
    assert created.status_code == 201
    state = created.json()["assistant_state"]
    state["answers"] = {"event_id": "ceramics", "year": 2027, "date": "2027-11-20", "time": "18:00"}
    state["partial_date"] = {"year": 2027, "month": 11, "day": 20, "hour": 18, "minute": 0}
    with connect_db(database_path) as connection:
        connection.execute(
            "UPDATE campaigns SET assistant_state_json=? WHERE id=?",
            (json.dumps(state), path.rsplit("/", 1)[1]),
        )
    saved = draft_client.patch(
        path,
        json=edit(
            event_id="painting",
            proposed_start=FUTURE,
            subject="Тема",
            body="Текст",
            mode="manual",
            manual_fields=["event_id", "date", "time"],
        ),
    )
    assert saved.status_code == 200
    updated = saved.json()["assistant_state"]
    assert updated["context_event_id"] == "painting"
    assert updated["answers"] == {"event_id": "painting"}
    assert updated["partial_date"] == {
        "year": 2099,
        "month": 11,
        "day": 20,
        "hour": 19,
        "minute": 0,
    }
    assert updated["original_prompt"] == "Старый запрос"


def test_sql_failure_during_meaningful_create_has_no_partial_campaign(
    draft_client: TestClient,
    database_path: Path,
) -> None:
    path = campaign_path()
    with connect_db(database_path) as connection:
        connection.execute(
            "CREATE TRIGGER reject_campaign BEFORE INSERT ON campaigns "
            "BEGIN SELECT RAISE(ABORT, 'private failure'); END"
        )
    response = draft_client.put(path, json={"prompt": "Перенос занятия"})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "storage_unavailable"
    assert "private failure" not in response.text
    assert draft_client.get(path).status_code == 404


def test_v1_upgrade_preserves_rows_bytes_and_old_preview(tmp_path: Path) -> None:
    migrations = tmp_path / "v1"
    migrations.mkdir()
    shutil.copyfile(MIGRATIONS_DIR / "001_notifications.sql", migrations / "001_notifications.sql")
    path = tmp_path / "v1.sqlite3"
    init_db(path, migrations)
    load_demo(path, FIXTURE)
    campaign_id = str(uuid4())
    token = str(uuid4())
    old_start = "2026-11-10T19:00:00+03:00"
    public_preview = {
        "token": token,
        "campaign_id": campaign_id,
        "draft_revision": 0,
        "event": {
            "id": "ceramics",
            "title": "Керамика",
            "starts_at": old_start,
            "timezone": "Europe/Moscow",
            "revision": 0,
        },
        "old_start": old_start,
        "proposed_start": FUTURE,
        "subject": "Тема",
        "body": "Текст",
        "recipients": ["a@example.com"],
    }
    snapshot = {
        "id": "ceramics",
        "title": "Керамика",
        "old_start": old_start,
        "new_start": FUTURE,
        "timezone": "Europe/Moscow",
        "event_revision_before": 0,
    }
    with connect_db(path) as connection:
        connection.execute(
            "INSERT INTO campaigns(id,created_at,updated_at,event_id,suggested_start,prompt,"
            "preview_json,event_snapshot_json,accepted_token) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                campaign_id,
                "2026-10-27T12:00:00Z",
                "2026-10-27T12:00:00Z",
                "ceramics",
                FUTURE,
                "Старый запрос",
                json.dumps({"public": public_preview, "source": {"original": "source"}}),
                json.dumps(snapshot),
                token,
            ),
        )
        connection.execute(
            "UPDATE campaigns SET phase='confirmed',revision=1,proposed_start=?,subject='Тема',"
            "body='Текст',confirmed_at='2026-10-27T12:00:00Z' WHERE id=?",
            (FUTURE, campaign_id),
        )
        suggestion_id = str(uuid4())
        connection.execute(
            "INSERT INTO campaigns(id,created_at,updated_at,suggested_start) VALUES (?,?,?,?)",
            (suggestion_id, "2026-10-27T12:00:00Z", "2026-10-27T12:00:00Z", FUTURE),
        )
        connection.execute(
            "INSERT INTO deliveries(id,campaign_id,email,message_id,mime,created_at) "
            "VALUES (?,?,?,?,?,?)",
            (
                str(uuid4()),
                campaign_id,
                "a@example.com",
                "original@sqoch.local",
                b"Subject: old\r\n\r\nbody\r\n",
                "2026-10-27T12:00:00Z",
            ),
        )
        original = {
            table: [dict(row) for row in connection.execute(f"SELECT * FROM {table}")]
            for table in ("events", "purchases", "campaigns", "deliveries")
        }
    init_db(path)
    init_db(path)
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        assert [
            row[0]
            for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")
        ] == [1, 2]
        assert "assistant_state_json" in {
            row[1] for row in connection.execute("PRAGMA table_info(campaigns)")
        }
        for table, before in original.items():
            after = [dict(row) for row in connection.execute(f"SELECT * FROM {table}")]
            for row in after:
                if table == "campaigns":
                    assert row.pop("assistant_state_json") is None
            assert after == before
    detail = get_campaign(path, UUID(campaign_id))
    assert detail.assistant_state is None
    assert detail.preview is not None
    assert detail.preview.model_dump(mode="json") == public_preview
    assert detail.event_snapshot is not None
    assert detail.event_snapshot.model_dump(mode="json") == snapshot
    summary = next(item for item in list_campaigns(path).items if str(item.id) == campaign_id)
    assert summary.preparation_stage is None
    assert summary.event_snapshot == detail.event_snapshot
    suggestion = get_campaign(path, UUID(suggestion_id))
    assert suggestion.proposed_start is None
    assert suggestion.suggested_start is not None
