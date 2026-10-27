"""Test-only network boundary. Not selected by the ordinary application entrypoint."""

import json
from datetime import UTC, datetime

import httpx

from sqoch_api.app import create_app

E2E_NOW = datetime(2026, 10, 27, tzinfo=UTC)


def completion(request: httpx.Request) -> httpx.Response:
    assert request.url.host == "api.deepseek.com"
    payload = json.loads(request.content)
    messages = payload["messages"]
    current = json.loads(
        next(message["content"] for message in messages if message["role"] == "user")
    )
    tool_messages = [message for message in messages if message["role"] == "tool"]
    if payload.get("tools"):
        name = "get_event_context" if tool_messages else "list_events"
        selected = current.get("context_event_id") or current.get("answers", {}).get("event_id")
        if selected is None:
            selected = "painting" if "Живопис" in current["original_prompt"] else "ceramics"
        arguments = {"event_id": selected} if tool_messages else {}
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "index": 0,
                    "id": f"test-{len(tool_messages)}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(arguments)},
                }
            ],
        }
        reason = "tool_calls"
    else:
        content: dict[str, object] = {
            "status": "ready",
            "subject": "Перенос мастер-класса «Керамика»",
            "body": "Мастер-класс перенесён. Проверьте новую дату в уведомлении.",
        }
        if tool_messages:
            context = json.loads(tool_messages[-1]["content"])
            start = context["transfer"]["proposed_start"]
            content.update(
                status="ready" if start else "needs_input",
                event_id=context["id"],
                subject=f"Перенос мероприятия «{context['title']}»",
                body=(
                    f"Мероприятие «{context['title']}» перенесено на {start}. "
                    "Время указано по Москве (Europe/Moscow)."
                    if start
                    else f"Готовим перенос мероприятия «{context['title']}». Дату нужно уточнить."
                ),
            )
        else:
            content["subject"] = current["subject"] + " (обновлено)"
            content["body"] = "Обновлённый текст уведомления"
        message = {"role": "assistant", "content": json.dumps(content, ensure_ascii=False)}
        reason = "stop"
    return httpx.Response(200, json={"choices": [{"finish_reason": reason, "message": message}]})


app = create_app(clock=lambda: E2E_NOW, ai_transport=httpx.MockTransport(completion))
