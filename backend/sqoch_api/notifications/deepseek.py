"""Bounded DeepSeek HTTP session and supported response protocol."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictStr, ValidationError

from sqoch_api.notifications.config import NotificationConfig
from sqoch_api.notifications.errors import OrganizerError

ACTION_TIMEOUT = 60.0
MAX_RESPONSE_BYTES = 131072
BASE_URL = "https://api.deepseek.com"


class ToolFunction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: StrictStr
    arguments: StrictStr


class ToolCall(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Annotated[StrictStr, Field(min_length=1)]
    type: Literal["function"]
    function: ToolFunction
    # DeepSeek may attach a sequence index even to a non-streaming response.
    index: Annotated[int, Field(strict=True, ge=0)] | None = Field(default=None, exclude=True)


class AssistantMessage(BaseModel):
    # Ignore provider metadata; only supported protocol fields are replayed.
    model_config = ConfigDict(extra="ignore")
    role: Literal["assistant"]
    content: StrictStr | None = None
    tool_calls: list[ToolCall] = []


class CompletionChoice(BaseModel):
    model_config = ConfigDict(extra="ignore")
    finish_reason: Literal["stop", "tool_calls"]
    message: AssistantMessage


class CompletionEnvelope(BaseModel):
    model_config = ConfigDict(extra="ignore")
    choices: Annotated[list[CompletionChoice], Field(min_length=1, max_length=1)]


def invalid_response() -> OrganizerError:
    return OrganizerError(
        502, "ai_invalid_response", "Помощник вернул некорректный ответ. Повторите запрос"
    )


@asynccontextmanager
async def deepseek_session(
    config: NotificationConfig, transport: httpx.AsyncBaseTransport | None = None
) -> AsyncIterator[httpx.AsyncClient]:
    """Own one action deadline, client cleanup and safe provider failure mapping."""
    assert config.deepseek_api_key is not None
    try:
        async with asyncio.timeout(ACTION_TIMEOUT):
            async with httpx.AsyncClient(
                base_url=BASE_URL,
                headers={"Authorization": f"Bearer {config.deepseek_api_key.get_secret_value()}"},
                timeout=httpx.Timeout(ACTION_TIMEOUT, connect=5),
                trust_env=False,
                follow_redirects=False,
                transport=transport,
            ) as client:
                yield client
    except TimeoutError, httpx.TimeoutException:
        raise OrganizerError(
            504, "ai_timeout", "Помощник не успел ответить. Повторите запрос"
        ) from None
    except httpx.RequestError:
        raise OrganizerError(
            502, "ai_unavailable", "Помощник недоступен. Повторите запрос"
        ) from None
    except ValidationError, ValueError, KeyError, TypeError:
        raise invalid_response() from None


async def complete(
    client: httpx.AsyncClient,
    config: NotificationConfig,
    messages: list[dict[str, object]],
    *,
    tools: list[dict[str, object]] | None = None,
) -> AssistantMessage:
    payload: dict[str, object] = {
        "model": config.deepseek_model,
        "thinking": {"type": "disabled"},
        "stream": False,
        "max_tokens": 4096,
        "messages": messages,
    }
    if tools is not None:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    else:
        payload["response_format"] = {"type": "json_object"}
    async with client.stream("POST", "/chat/completions", json=payload) as response:
        if response.status_code != 200:
            raise OrganizerError(502, "ai_unavailable", "Помощник недоступен. Повторите запрос")
        body = bytearray()
        async for chunk in response.aiter_bytes():
            if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                raise invalid_response()
            body.extend(chunk)
        envelope = CompletionEnvelope.model_validate_json(body)
    message = envelope.choices[0].message
    if tools is None and message.tool_calls:
        raise invalid_response()
    if not message.tool_calls and (message.content is None or not message.content.strip()):
        raise invalid_response()
    return message
