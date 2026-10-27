"""Pydantic-owned organizer request and public response contracts."""

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import (
    AwareDatetime,
    Field,
    StrictBool,
    StrictStr,
    ValidationInfo,
    field_serializer,
    field_validator,
    model_validator,
)
from pydantic.json_schema import SkipJsonSchema

from sqoch_api.notifications.assistant_state import (
    AssistantState,
    ManualField,
    ManualFields,
    NonemptyId,
    PreparationMode,
    Prompt,
    unique_manual_fields,
)
from sqoch_api.orders import StrictModel, ValidationIssue

MOSCOW = ZoneInfo("Europe/Moscow")
Revision = Annotated[int, Field(strict=True, ge=0)]
DeliveryState = Literal["pending", "sending", "retry_wait", "sent", "failed", "unknown"]
CampaignStatus = Literal[
    "draft", "processing", "needs_attention", "completed", "completed_with_errors"
]
Subject = Annotated[StrictStr, Field(max_length=200)]
Body = Annotated[StrictStr, Field(max_length=10000)]


class EmptyRequest(StrictModel):
    pass


class OrganizerEvent(StrictModel):
    id: str
    title: str
    starts_at: AwareDatetime
    timezone: Literal["Europe/Moscow"]
    revision: Revision

    @field_serializer("starts_at")
    def serialize_start(self, value: datetime) -> str:
        return value.astimezone(MOSCOW).isoformat()


class OrganizerEvents(StrictModel):
    items: list[OrganizerEvent]


class CampaignCounters(StrictModel):
    total: int = 0
    pending: int = 0
    sending: int = 0
    retry_wait: int = 0
    sent: int = 0
    failed: int = 0
    unknown: int = 0


class CampaignDelivery(StrictModel):
    id: str
    email: str
    state: DeliveryState
    attempts: int
    next_attempt_at: AwareDatetime | None
    sent_at: AwareDatetime | None
    error_code: str | None
    error_message: str | None


class EventSnapshot(StrictModel):
    id: str
    title: str
    old_start: AwareDatetime
    new_start: AwareDatetime
    timezone: Literal["Europe/Moscow"]
    event_revision_before: Revision

    @field_serializer("old_start", "new_start")
    def serialize_date(self, value: datetime) -> str:
        return value.astimezone(MOSCOW).isoformat()


class CampaignPreview(StrictModel):
    token: UUID
    campaign_id: UUID
    draft_revision: Revision
    event: OrganizerEvent
    old_start: AwareDatetime
    proposed_start: AwareDatetime
    subject: str
    body: str
    recipients: list[str]

    @field_serializer("old_start", "proposed_start")
    def serialize_date(self, value: datetime) -> str:
        return value.astimezone(MOSCOW).isoformat()


class CampaignDetail(StrictModel):
    id: UUID
    phase: Literal["draft", "confirmed"]
    revision: Revision
    created_at: AwareDatetime
    updated_at: AwareDatetime
    event_id: str | None
    proposed_start: AwareDatetime | None
    suggested_start: AwareDatetime | None
    assistant_state: AssistantState | None
    subject: str
    body: str
    text_reviewed: bool
    reviewed_event_revision: Revision | None
    confirmed_at: AwareDatetime | None
    event_snapshot: EventSnapshot | None
    preview: CampaignPreview | None
    status: CampaignStatus
    counters: CampaignCounters
    deliveries: list[CampaignDelivery]

    @field_serializer("proposed_start", "suggested_start")
    def serialize_date(self, value: datetime | None) -> str | None:
        return value.astimezone(MOSCOW).isoformat() if value else None


class CampaignSummary(StrictModel):
    id: UUID
    phase: Literal["draft", "confirmed"]
    revision: Revision
    created_at: AwareDatetime
    updated_at: AwareDatetime
    event_id: str | None
    event_title: str | None
    subject: str
    proposed_start: AwareDatetime | None
    status: CampaignStatus
    counters: CampaignCounters
    has_content: bool
    preparation_stage: (
        Literal["empty", "manual", "intake", "applied", "needs_input", "failed"] | None
    )
    event_snapshot: EventSnapshot | None

    @field_serializer("proposed_start")
    def serialize_date(self, value: datetime | None) -> str | None:
        return value.astimezone(MOSCOW).isoformat() if value else None


class CampaignList(StrictModel):
    items: list[CampaignSummary]


class CampaignFields(StrictModel):
    event_id: Annotated[StrictStr, Field(min_length=1)] | None
    proposed_start: AwareDatetime | None
    subject: Subject
    body: Body

    @field_validator("subject", "body", mode="before")
    @classmethod
    def normalize_text(cls, value: object, info: ValidationInfo) -> object:
        if isinstance(value, str):
            if info.field_name == "subject" and ("\r" in value or "\n" in value):
                raise ValueError("Тема должна занимать одну строку")
            return value.strip()
        return value

    @field_validator("proposed_start")
    @classmethod
    def require_moscow_offset(cls, value: datetime | None) -> datetime | None:
        if value is not None:
            try:
                value.astimezone(UTC)
                moscow_offset = value.astimezone(MOSCOW).utcoffset()
            except OverflowError, ValueError:
                raise ValueError("Укажите дату и время в допустимом диапазоне") from None
            if value.utcoffset() != moscow_offset:
                raise ValueError("Укажите дату и время в часовом поясе Europe/Moscow")
        return value

    @field_validator("proposed_start", mode="before")
    @classmethod
    def require_iso_string(cls, value: object) -> object:
        if value is not None and not isinstance(value, str):
            raise ValueError("Укажите дату строкой ISO 8601 с часовым поясом")
        return value


class SaveCampaignRequest(CampaignFields):
    expected_revision: Revision
    text_reviewed: StrictBool
    reviewed_event_revision: Revision | None = None
    mode: PreparationMode = "assistant"
    manual_fields: ManualFields = Field(default_factory=list)
    prompt: Annotated[StrictStr, Field(max_length=4000)] | SkipJsonSchema[None] = None

    @field_validator("prompt", mode="before")
    @classmethod
    def saved_prompt(cls, value: object) -> object:
        if value is None:
            raise ValueError("Запрос не может быть null")
        if isinstance(value, str):
            value = value.strip()
            if len(value) > 4000:
                raise ValueError("Введите запрос длиной до 4000 символов")
        return value

    @field_validator("manual_fields")
    @classmethod
    def distinct_fields(cls, value: list[ManualField]) -> list[ManualField]:
        return unique_manual_fields(value)


class CreateCampaignRequest(CampaignFields):
    mode: PreparationMode = "assistant"
    prompt: Prompt = ""
    context_event_id: NonemptyId | None = None
    event_id: NonemptyId | None = None
    proposed_start: AwareDatetime | None = None
    subject: Subject = ""
    body: Body = ""
    manual_fields: ManualFields = Field(default_factory=list)

    @field_validator("prompt", mode="before")
    @classmethod
    def trim_prompt(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("manual_fields")
    @classmethod
    def distinct_fields(cls, value: list[ManualField]) -> list[ManualField]:
        return unique_manual_fields(value)

    @model_validator(mode="after")
    def compatible_context(self) -> CreateCampaignRequest:
        if self.context_event_id and self.event_id and self.context_event_id != self.event_id:
            raise ValueError("Выбранное мероприятие и контекст должны совпадать")
        return self


class PreviewRequest(StrictModel):
    expected_revision: Revision


class ConfirmCampaignRequest(StrictModel):
    preview_token: UUID


class OrganizerErrorDetail(StrictModel):
    code: str
    message: str
    related_campaign_id: str | None = None


class OrganizerErrorResponse(StrictModel):
    detail: OrganizerErrorDetail


class OrganizerValidationResponse(StrictModel):
    detail: list[ValidationIssue] | OrganizerErrorDetail
