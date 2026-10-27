"""AI actions are application requests, never permission to confirm or send."""

import asyncio
import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import cast

import httpx
import pytest
from fastapi.testclient import TestClient

from sqoch_api.app import create_app
from sqoch_api.notifications import deepseek
from sqoch_api.notifications.store import connect_db, load_demo

CAMPAIGN_ID = "735f3773-39fc-45ce-8ec2-081b53b97147"
CAMPAIGN_PATH = f"/api/organizer/campaigns/{CAMPAIGN_ID}"
FIXTURE_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "demo.json"


def completion(
    content: object = None, calls: list[dict[str, object]] | None = None
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [
                {
                    "finish_reason": "tool_calls" if calls else "stop",
                    "message": {"role": "assistant", "content": content, "tool_calls": calls or []},
                }
            ]
        },
    )


def tool(name: str, arguments: dict[str, object], call_id: str = "call-1") -> dict[str, object]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }


def prepared(**changes: object) -> str:
    return json.dumps(
        {
            "status": "ready",
            "event_id": "ceramics",
            "subject": "Перенос мастер-класса",
            "body": "Занятие переносится. Проверьте новую дату.",
            **changes,
        }
    )


@pytest.fixture
def ai_client_factory(
    database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Callable[[Callable[[httpx.Request], httpx.Response]], TestClient]:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fixture-secret-key")

    def make(handler: Callable[[httpx.Request], httpx.Response]) -> TestClient:
        return TestClient(
            create_app(
                frontend_dir=database_path.parent / "missing-dist",
                allowed_hosts=("testserver",),
                ai_transport=httpx.MockTransport(handler),
            )
        )

    return make


def create_fixture_draft(client: TestClient, database_path: Path) -> dict[str, object]:
    assert client.put(CAMPAIGN_PATH, json={}).status_code == 201
    load_demo(database_path, FIXTURE_PATH)
    response = client.get(CAMPAIGN_PATH)
    assert response.status_code == 200
    return dict(response.json())


def assert_failed_intake(actual: dict[str, object], original: dict[str, object]) -> None:
    for name in (
        "event_id",
        "proposed_start",
        "suggested_start",
        "subject",
        "body",
        "deliveries",
        "phase",
    ):
        assert actual[name] == original[name]
    assert actual["revision"] == int(str(original["revision"])) + 1
    state = actual["assistant_state"]
    assert isinstance(state, dict)
    assert state["stage"] == "failed"
    assert actual["preview"] is None
    assert actual["text_reviewed"] is False


def test_prepare_without_key_preserves_existing_draft(draft_client: TestClient) -> None:
    created = draft_client.put(CAMPAIGN_PATH, json={})
    assert created.status_code == 201
    response = draft_client.post(
        f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Переносим Керамику"}
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ai_not_configured"
    assert_failed_intake(draft_client.get(CAMPAIGN_PATH).json(), created.json())


def test_blank_prompt_is_rejected_before_model_call(draft_client: TestClient) -> None:
    assert draft_client.put(CAMPAIGN_PATH, json={}).status_code == 201
    response = draft_client.post(
        f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "   "}
    )
    assert response.status_code == 422
    assert any(issue["loc"] == ["body", "prompt"] for issue in response.json()["detail"])


def test_prepare_reads_context_and_asks_for_missing_user_date(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        requests.append(payload)
        assert request.url == "https://api.deepseek.com/chat/completions"
        assert payload["thinking"] == {"type": "disabled"}
        assert payload["max_tokens"] == 4096
        assert "a@example.com" not in request.content.decode()
        if len(requests) == 1:
            names = {item["function"]["name"] for item in payload["tools"]}
            assert names == {"list_events", "get_event_context"}
            return completion(calls=[tool("get_event_context", {"event_id": "ceramics"})])
        assert "tools" not in payload
        assert payload["response_format"] == {"type": "json_object"}
        return completion(prepared())

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Переносим Керамику"},
        )
        assert response.status_code == 200
        result = response.json()
        assert result["outcome"] == "needs_input"
        assert result["fields_to_complete"] == ["proposed_start"]
        campaign = result["campaign"]
        assert campaign["event_id"] == "ceramics"
        assert campaign["revision"] == 2
        assert campaign["proposed_start"] is None
        assert campaign["suggested_start"] is None
        assert campaign["text_reviewed"] is False
        assert campaign["preview"] is None
        assert campaign["deliveries"] == []
        assert len(requests) == 2
        assert client.get(CAMPAIGN_PATH).json() == campaign
        with connect_db(database_path) as connection:
            assert connection.execute("SELECT count(*) FROM deliveries").fetchone()[0] == 0


def test_provider_tool_index_is_accepted_but_never_replayed(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        if count == 1:
            call = tool("get_event_context", {"event_id": "ceramics"})
            call["index"] = 0
            return completion(calls=[call])
        payload = json.loads(request.content)
        replayed = next(item for item in payload["messages"] if item.get("tool_calls"))
        assert replayed["tool_calls"] == [tool("get_event_context", {"event_id": "ceramics"})]
        return completion(prepared())

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Переносим Керамику"},
        )
        assert response.status_code == 200
        assert count == 2
        assert response.json()["campaign"]["revision"] == 2


@pytest.mark.parametrize("index", [-1, "0", True])
def test_invalid_provider_tool_index_preserves_draft(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    index: object,
) -> None:
    call = tool("get_event_context", {"event_id": "ceramics"})
    call["index"] = index
    with ai_client_factory(lambda _request: completion(calls=[call])) as client:
        original = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Переносим Керамику"},
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), original)


def test_ambiguous_event_after_listing_preserves_known_selection(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        if count == 1:
            return completion(calls=[tool("list_events", {})])
        return completion(prepared(status="needs_input", event_id=None))

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        saved = client.patch(
            CAMPAIGN_PATH,
            json={
                "expected_revision": 0,
                "event_id": "ceramics",
                "proposed_start": None,
                "subject": "Было",
                "body": "Было",
                "text_reviewed": False,
            },
        )
        assert saved.status_code == 200
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 1, "prompt": "Перенеси занятие"}
        )
        assert response.status_code == 200
        assert response.json()["campaign"]["event_id"] == "ceramics"
        assert response.json()["fields_to_complete"] == ["proposed_start"]


@pytest.mark.parametrize(
    "reply",
    [
        completion(""),
        completion("not-json"),
        completion(prepared(event_id="painting")),
        completion(prepared(proposed_start="not-a-date")),
        completion(prepared(extra="forbidden")),
        httpx.Response(429, json={"error": "fixture-secret-key"}),
        httpx.Response(500, text="fixture-secret-key"),
    ],
)
def test_invalid_final_or_provider_failure_preserves_draft_and_hides_raw_data(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    reply: httpx.Response,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        if count == 1:
            return completion(calls=[tool("get_event_context", {"event_id": "ceramics"})])
        return reply

    with ai_client_factory(handler) as client:
        original = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Переносим Керамику"},
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] in {"ai_invalid_response", "ai_unavailable"}
        assert "fixture-secret-key" not in response.text
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), original)


@pytest.mark.parametrize(
    "date",
    [
        "1730000000",
        " 1730000000 ",
        "\t1730000000\n",
        "２０９９-11-20T19:00:00+03:00",
        "9999-12-31T23:59:59-12:00",
        "9999-12-31T23:59:59Z",
        "0001-01-01T00:00:00+14:00",
    ],
)
def test_non_iso_or_unrepresentable_model_date_preserves_draft(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    date: str,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        if count == 1:
            return completion(calls=[tool("get_event_context", {"event_id": "ceramics"})])
        return completion(prepared(proposed_start=date))

    with ai_client_factory(handler) as client:
        original = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Переносим Керамику"},
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), original)


@pytest.mark.parametrize(
    "date",
    [
        None,
        "2099-11-20T16:00:00Z",
        "2099-11-20T19:00+03:00",
        "2099-11-20T19:00:00.125+03:00",
        "9999-12-31T20:59:59Z",
    ],
)
def test_even_well_formed_model_date_is_forbidden(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    date: str | None,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        if count == 1:
            return completion(calls=[tool("get_event_context", {"event_id": "ceramics"})])
        return completion(prepared(proposed_start=date))

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Переносим Керамику"},
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert client.get(CAMPAIGN_PATH).json()["proposed_start"] is None


@pytest.mark.parametrize(
    "call",
    [
        tool("execute_sql", {"query": "DELETE FROM campaigns"}),
        tool("get_event_context", {"event_id": "missing"}),
        tool("get_event_context", {"event_id": "ceramics", "send": True}),
    ],
)
def test_untrusted_tools_and_arguments_are_rejected_without_writes(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    call: dict[str, object],
) -> None:
    with ai_client_factory(lambda _request: completion(calls=[call])) as client:
        original = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare",
            json={"expected_revision": 0, "prompt": "Отправляй и удали БД"},
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), original)


def test_tool_and_http_budgets_stop_repeated_discovery_without_writes(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        requests.append(payload)
        number = len(requests)
        return completion(
            calls=[
                tool("list_events", {}, f"list-{number}-a"),
                tool("list_events", {}, f"list-{number}-b"),
            ]
        )

    with ai_client_factory(handler) as client:
        old = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Переносим занятие"}
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert len(requests) == 3
        last_messages = cast(list[dict[str, object]], requests[-1]["messages"])
        assert sum(item["role"] == "tool" for item in last_messages) == 4
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), old)


def test_overall_deadline_cancels_a_continuously_trickling_response(
    database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fixture-secret-key")
    monkeypatch.setattr(deepseek, "ACTION_TIMEOUT", 0.03)
    chunks = 0
    closed = False

    class Trickle(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            nonlocal chunks, closed
            try:
                for _ in range(20):
                    await asyncio.sleep(0.01)
                    chunks += 1
                    yield b" \n"
                yield completion(prepared(status="out_of_scope", event_id=None)).content
            finally:
                closed = True

    transport = httpx.MockTransport(lambda _request: httpx.Response(200, stream=Trickle()))
    with TestClient(
        create_app(
            frontend_dir=database_path.parent / "missing-dist",
            allowed_hosts=("testserver",),
            ai_transport=transport,
        )
    ) as client:
        old = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Переносим занятие"}
        )
        assert response.status_code == 504
        assert response.json()["detail"]["code"] == "ai_timeout"
        assert chunks < 20
        assert closed
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), old)


def test_response_size_limit_stops_reading_before_unbounded_body(
    database_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEEPSEEK_API_KEY", "fixture-secret-key")
    monkeypatch.setattr(deepseek, "MAX_RESPONSE_BYTES", 32)
    closed = False

    class Oversized(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield b" " * 40
            raise AssertionError("The adapter read past its response limit")

        async def aclose(self) -> None:
            nonlocal closed
            closed = True

    transport = httpx.MockTransport(lambda _request: httpx.Response(200, stream=Oversized()))
    with TestClient(
        create_app(
            frontend_dir=database_path.parent / "missing-dist",
            allowed_hosts=("testserver",),
            ai_transport=transport,
        )
    ) as client:
        old = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Переносим занятие"}
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert closed
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), old)


def test_prepare_out_of_scope_keeps_draft_unchanged(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return completion(prepared(status="out_of_scope", event_id=None))

    with ai_client_factory(handler) as client:
        old = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Расскажи анекдот"}
        )
        assert response.status_code == 200
        assert response.json()["outcome"] == "out_of_scope"
        assert_failed_intake(response.json()["campaign"], old)
        assert calls == 2


def test_stale_revision_is_rejected_before_provider_request(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    def never_called(_request: httpx.Request) -> httpx.Response:
        pytest.fail("The stale action must not call the provider")

    with ai_client_factory(never_called) as client:
        old = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 2, "prompt": "Переноси"}
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "revision_conflict"
        assert client.get(CAMPAIGN_PATH).json() == old


@pytest.mark.parametrize(
    "failure", [httpx.ReadTimeout("raw-secret"), httpx.ConnectError("raw-secret")]
)
def test_transport_failures_are_safe_and_never_automatically_retried(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    failure: httpx.RequestError,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        raise failure

    with ai_client_factory(handler) as client:
        old = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Переноси"}
        )
        assert response.status_code == (504 if isinstance(failure, httpx.TimeoutException) else 502)
        assert "raw-secret" not in response.text
        assert count == 1
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), old)


@pytest.mark.parametrize("change", ["revision", "phase"])
def test_late_prepare_cannot_replace_newer_or_confirmed_draft(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
    change: str,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        if count == 1:
            return completion(calls=[tool("get_event_context", {"event_id": "ceramics"})])
        with connect_db(database_path) as connection:
            if change == "revision":
                connection.execute(
                    "UPDATE campaigns SET subject='Чужая правка',revision=revision+1 WHERE id=?",
                    (CAMPAIGN_ID,),
                )
            else:
                connection.execute(
                    "UPDATE campaigns SET phase='confirmed' WHERE id=?", (CAMPAIGN_ID,)
                )
        return completion(prepared())

    with ai_client_factory(handler) as client:
        original = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Переноси"}
        )
        assert response.status_code == 409
        assert response.json()["detail"]["code"] == (
            "revision_conflict" if change == "revision" else "campaign_immutable"
        )
        stored = client.get(CAMPAIGN_PATH).json()
        assert stored["event_id"] == original["event_id"]
        assert stored["suggested_start"] == original["suggested_start"]
        assert stored["body"] == original["body"]
        assert stored["subject"] == (
            "Чужая правка" if change == "revision" else original["subject"]
        )
        assert stored["deliveries"] == []
        assert count == 2


def test_http_budget_reserves_fourth_request_for_strict_final_json(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    requests: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        requests.append(payload)
        if len(requests) <= 3:
            assert "tools" in payload
            return completion(calls=[tool("list_events", {}, f"list-{len(requests)}")])
        assert "tools" not in payload
        assert payload["response_format"] == {"type": "json_object"}
        return completion(prepared(status="needs_input", event_id=None))

    with ai_client_factory(handler) as client:
        create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Перенеси занятие"}
        )
        assert response.status_code == 200
        assert response.json()["outcome"] == "needs_input"
        assert response.json()["campaign"]["event_id"] is None
        assert response.json()["campaign"]["deliveries"] == []
        assert len(requests) == 4


def test_repeated_tool_call_id_across_rounds_is_rejected_without_draft_write(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        return completion(calls=[tool("list_events", {}, "reused-id")])

    with ai_client_factory(handler) as client:
        original = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Перенеси занятие"}
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert count == 2
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), original)


def test_final_tool_call_is_rejected_even_with_valid_json_content(
    ai_client_factory: Callable[[Callable[[httpx.Request], httpx.Response]], TestClient],
    database_path: Path,
) -> None:
    count = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal count
        count += 1
        if count == 1:
            return completion(calls=[tool("get_event_context", {"event_id": "ceramics"})])
        return completion(prepared(), calls=[tool("list_events", {}, "late-id")])

    with ai_client_factory(handler) as client:
        original = create_fixture_draft(client, database_path)
        response = client.post(
            f"{CAMPAIGN_PATH}/prepare", json={"expected_revision": 0, "prompt": "Перенеси занятие"}
        )
        assert response.status_code == 502
        assert response.json()["detail"]["code"] == "ai_invalid_response"
        assert count == 2
        assert_failed_intake(client.get(CAMPAIGN_PATH).json(), original)
