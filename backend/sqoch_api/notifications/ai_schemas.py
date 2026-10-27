"""Bounded AI requests and untrusted model output contracts."""

from typing import Annotated, Literal, Self

from pydantic import Field, StrictStr, ValidationInfo, field_validator, model_validator
from pydantic.json_schema import SkipJsonSchema

from sqoch_api.notifications.assistant_state import (
    AssistantAnswers,
    Clarification,
    NonemptyId,
    Prompt,
)
from sqoch_api.notifications.schemas import Body, CampaignDetail, Revision, Subject
from sqoch_api.orders import StrictModel

Instruction = Annotated[StrictStr, Field(min_length=1, max_length=4000)]


class PrepareRequest(StrictModel):
    expected_revision: Revision
    prompt: Prompt | SkipJsonSchema[None] = None
    answers: AssistantAnswers = Field(default_factory=AssistantAnswers)
    context_event_id: NonemptyId | None = None

    @field_validator("prompt", mode="before")
    @classmethod
    def trim_prompt(cls, value: object) -> object:
        if value is None:
            raise ValueError("Запрос не может быть null")
        if isinstance(value, str):
            value = value.strip()
            if not value or len(value) > 4000:
                raise ValueError("Введите запрос длиной от 1 до 4000 символов")
        return value

    @model_validator(mode="after")
    def consistent_answers(self) -> Self:
        if (
            self.answers.year is not None
            and self.answers.date is not None
            and int(self.answers.date[:4]) != self.answers.year
        ):
            raise ValueError("Год и полная дата ответа должны совпадать")
        return self


class RewriteRequest(StrictModel):
    expected_revision: Revision
    instruction: Instruction

    @field_validator("instruction", mode="before")
    @classmethod
    def trim_instruction(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class AIActionResponse(StrictModel):
    outcome: Literal["applied", "needs_input", "out_of_scope"]
    campaign: CampaignDetail
    fields_to_complete: list[Literal["event_id", "proposed_start", "subject", "body"]]
    clarifications: list[Clarification] = Field(default_factory=list)
    message: str


class GeneratedText(StrictModel):
    subject: Subject
    body: Body

    @field_validator("subject", "body", mode="before")
    @classmethod
    def normalize_text(cls, value: object, info: ValidationInfo) -> object:
        if isinstance(value, str):
            if info.field_name == "subject" and ("\r" in value or "\n" in value):
                raise ValueError("Subject must be a single line")
            return value.strip()
        return value


class PreparedContent(GeneratedText):
    status: Literal["ready", "needs_input", "out_of_scope"]
    event_id: StrictStr | None


class RewrittenContent(GeneratedText):
    status: Literal["ready", "out_of_scope"]


class NoArguments(StrictModel):
    pass


class EventArguments(StrictModel):
    event_id: Annotated[StrictStr, Field(min_length=1)]
