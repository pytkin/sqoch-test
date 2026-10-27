"""Versioned saved preparation context; no resolver, network or database effects."""

import re
from datetime import date, datetime, time
from typing import Annotated, Literal, Self, TypedDict
from zoneinfo import ZoneInfo

from pydantic import (
    ConfigDict,
    Field,
    StrictStr,
    field_validator,
    model_serializer,
    model_validator,
    with_config,
)
from pydantic.json_schema import SkipJsonSchema

from sqoch_api.orders import StrictModel

PreparationMode = Literal["assistant", "manual"]
PreparationStage = Literal["intake", "applied", "needs_input", "failed"]
YearSource = Literal["explicit", "current_year", "clarification", "manual"]
ManualField = Literal["event_id", "date", "time"]
ManualFields = Annotated[list[ManualField], Field(max_length=3)]
NonemptyId = Annotated[StrictStr, Field(min_length=1)]
Prompt = Annotated[StrictStr, Field(min_length=1, max_length=4000)]
StateRevision = Annotated[int, Field(strict=True, ge=0)]
Year = Annotated[int, Field(strict=True, ge=1, le=9999)]
Month = Annotated[int, Field(strict=True, ge=1, le=12)]
Day = Annotated[int, Field(strict=True, ge=1, le=31)]
Hour = Annotated[int, Field(strict=True, ge=0, le=23)]
Minute = Annotated[int, Field(strict=True, ge=0, le=59)]


def unique_manual_fields(value: list[ManualField]) -> list[ManualField]:
    if len(value) != len(set(value)):
        raise ValueError("Ручные поля не должны повторяться")
    return value


@with_config(
    ConfigDict(
        extra="forbid",
        json_schema_serialization_defaults_required=False,
        # Pydantic 2.14 computes TypedDict requiredness before applying this local config.
        # Every answer is optional (total=False), including inside a strict response parent.
        json_schema_extra={"required": []},
    )
)
class AnswersOutput(TypedDict, total=False):
    event_id: str
    year: int
    date: str
    time: str


class AssistantAnswers(StrictModel):
    event_id: NonemptyId | SkipJsonSchema[None] = None
    year: Year | SkipJsonSchema[None] = None
    date: StrictStr | SkipJsonSchema[None] = None
    time: StrictStr | SkipJsonSchema[None] = None

    @field_validator("event_id", "year", "date", "time", mode="before")
    @classmethod
    def reject_explicit_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("Ответ не может быть null")
        return value

    @field_validator("date")
    @classmethod
    def calendar_date(cls, value: str | None) -> str | None:
        if value is not None:
            if re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
                raise ValueError("Укажите дату YYYY-MM-DD")
            date.fromisoformat(value)
        return value

    @field_validator("time")
    @classmethod
    def clock_time(cls, value: str | None) -> str | None:
        if value is not None:
            if re.fullmatch(r"[0-9]{2}:[0-9]{2}", value) is None:
                raise ValueError("Укажите время HH:mm")
            time.fromisoformat(value)
        return value

    @model_serializer
    def serialize_answers(self) -> AnswersOutput:
        result: AnswersOutput = {}
        if self.event_id is not None:
            result["event_id"] = self.event_id
        if self.year is not None:
            result["year"] = self.year
        if self.date is not None:
            result["date"] = self.date
        if self.time is not None:
            result["time"] = self.time
        return result


class PartialDate(StrictModel):
    year: Year | None
    month: Month | None
    day: Day | None
    hour: Hour | None
    minute: Minute | None

    @model_validator(mode="after")
    def valid_components(self) -> Self:
        if self.month is not None and self.day is not None:
            # Leap-capable reference validates partial month/day without storing a guessed year.
            date(self.year if self.year is not None else 2000, self.month, self.day)
        return self


def partial_from_start(value: datetime | None) -> PartialDate:
    local = value.astimezone(ZoneInfo("Europe/Moscow")) if value else None
    return PartialDate(
        year=local.year if local else None,
        month=local.month if local else None,
        day=local.day if local else None,
        hour=local.hour if local else None,
        minute=local.minute if local else None,
    )


class Clarification(StrictModel):
    field: Literal["event_id", "year", "date", "time"]
    reason: Literal["missing", "ambiguous", "invalid", "past", "conflict"]
    candidate_event_id: NonemptyId | None

    @model_validator(mode="after")
    def event_candidate_only(self) -> Self:
        if self.candidate_event_id is not None and self.field != "event_id":
            raise ValueError("Предложение события относится только к выбору мероприятия")
        return self


class AssistantState(StrictModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=False)

    version: Literal[1]
    mode: PreparationMode
    stage: PreparationStage
    original_prompt: Annotated[StrictStr, Field(max_length=4000)]
    answers: AssistantAnswers
    context_event_id: NonemptyId | None
    partial_date: PartialDate
    manual_fields: ManualFields
    clarifications: Annotated[list[Clarification], Field(max_length=4)]
    intake_revision: StateRevision | None
    applied_revision: StateRevision | None
    year_source: YearSource | None = None

    @field_validator("version", mode="before")
    @classmethod
    def strict_version(cls, value: object) -> object:
        if type(value) is not int or value != 1:
            raise ValueError("Неизвестная версия состояния подготовки")
        return value

    @field_validator("original_prompt", mode="before")
    @classmethod
    def trim_prompt(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @field_validator("manual_fields")
    @classmethod
    def distinct_fields(cls, value: list[ManualField]) -> list[ManualField]:
        return unique_manual_fields(value)

    @model_validator(mode="after")
    def known_year_source(self) -> Self:
        if self.year_source is not None and self.partial_date.year is None:
            raise ValueError("Источник года требует сохранённый год")
        return self
