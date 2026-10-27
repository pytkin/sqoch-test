"""Read-only Mailpit evidence for an already attempted SMTP delivery."""

from dataclasses import dataclass
from email import policy
from email.errors import MessageError
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses
from typing import Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from sqoch_api.notifications.config import load_config
from sqoch_api.notifications.delivery import DeliveryJob


class SearchHit(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: StrictStr = Field(alias="ID", min_length=1)
    message_id: StrictStr = Field(alias="MessageID")


class SearchPage(BaseModel):
    model_config = ConfigDict(extra="ignore")
    messages_count: StrictInt = Field(ge=0)
    messages: list[SearchHit]


@dataclass(frozen=True)
class MatchResult:
    code: Literal[
        "matched",
        "not_found_in_mailpit",
        "mailpit_mismatch",
        "mailpit_duplicates",
        "mailpit_unavailable",
    ]
    message_id: str | None = None


class MailpitClient:
    def __init__(self, base_url: str, *, transport: httpx.BaseTransport | None = None) -> None:
        self.base_url = load_config({"SQOCH_MAILPIT_URL": base_url}).mailpit_url
        self.transport = transport

    def check(self, job: DeliveryJob) -> MatchResult:
        try:
            with httpx.Client(
                base_url=self.base_url,
                transport=self.transport,
                timeout=5,
                trust_env=False,
                follow_redirects=False,
            ) as client:
                matches: dict[str, SearchHit] = {}
                start = 0
                while True:
                    response = client.get(
                        "/api/v1/search",
                        params={
                            "query": f"message-id:{job.message_id}",
                            "start": start,
                            "limit": 100,
                        },
                    )
                    response.raise_for_status()
                    page = SearchPage.model_validate(response.json())
                    if not page.messages:
                        if start < page.messages_count:
                            return MatchResult("mailpit_unavailable")
                        break
                    for item in page.messages:
                        if _message_id(item.message_id) == job.message_id:
                            matches[item.id] = item
                    if len(matches) > 1:
                        return MatchResult("mailpit_duplicates")
                    start += len(page.messages)
                    if start >= page.messages_count:
                        break
                    # A corrupt endpoint must not make an unbounded read loop.
                    if start >= 10000:
                        return MatchResult("mailpit_unavailable")
                if not matches:
                    return MatchResult("not_found_in_mailpit")
                identifier = next(iter(matches))
                raw = client.get(f"/api/v1/message/{quote(identifier, safe='')}/raw")
                raw.raise_for_status()
                if not _corresponds(job, raw.content):
                    return MatchResult("mailpit_mismatch")
                return MatchResult("matched", identifier)
        except httpx.HTTPError, ValueError, MessageError, UnicodeError, LookupError:
            return MatchResult("mailpit_unavailable")


def _message_id(value: str) -> str:
    return value[1:-1] if value.startswith("<") and value.endswith(">") else value


def _parse(raw: bytes) -> EmailMessage:
    return BytesParser(policy=policy.default).parsebytes(raw)


def _one(message: EmailMessage, name: str) -> str | None:
    values = message.get_all(name, [])
    return str(values[0]) if len(values) == 1 else None


def _corresponds(job: DeliveryJob, raw: bytes) -> bool:
    expected, actual = _parse(job.mime), _parse(raw)
    if actual.defects or actual.is_multipart() or actual.get_content_type() != "text/plain":
        return False
    identifier = _one(actual, "Message-ID")
    if identifier is None or _message_id(identifier) != job.message_id:
        return False
    if _one(actual, "X-Sqoch-Campaign-ID") != job.campaign_id:
        return False
    for header in ("From", "To"):
        actual_value, expected_value = _one(actual, header), _one(expected, header)
        if actual_value is None or expected_value is None:
            return False
        if getaddresses([actual_value]) != getaddresses([expected_value]):
            return False
    if _one(actual, "Subject") != _one(expected, "Subject"):
        return False
    actual_text, expected_text = actual.get_content(), expected.get_content()
    return (
        isinstance(actual_text, str)
        and isinstance(expected_text, str)
        and (actual_text.replace("\r\n", "\n") == expected_text.replace("\r\n", "\n"))
    )
