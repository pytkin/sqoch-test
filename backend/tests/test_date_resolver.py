"""Pure date policy at calendar, timezone, ambiguity and manual-value boundaries."""

from datetime import UTC, datetime

import pytest

from sqoch_api.notifications.assistant_state import (
    AssistantAnswers,
    AssistantState,
    partial_from_start,
)
from sqoch_api.notifications.date_resolver import resolve_date
from sqoch_api.notifications.schemas import OrganizerEvent


def state(prompt: str) -> AssistantState:
    return AssistantState(
        version=1,
        mode="assistant",
        stage="intake",
        original_prompt=prompt,
        answers=AssistantAnswers(),
        context_event_id="ceramics",
        partial_date=partial_from_start(None),
        manual_fields=[],
        clarifications=[],
        intake_revision=1,
        applied_revision=None,
    )


def event(year: int = 2026) -> OrganizerEvent:
    return OrganizerEvent(
        id="ceramics",
        title="Керамика",
        starts_at=datetime.fromisoformat(f"{year}-11-10T19:00:00+03:00"),
        timezone="Europe/Moscow",
        revision=0,
    )


@pytest.mark.parametrize(
    "prompt,field,reason",
    [
        ("Перенести на 20 ноября 2027 или позже в 19:00", "date", "ambiguous"),
        ("Перенести на 20 ноября 2027 в 19:00 по Берлину", "time", "conflict"),
        ("Перенести на 20 ноября 2027 в 19:00 CET", "time", "conflict"),
        ("Перенести на 20 ноября 27 года в 19:00", "year", "invalid"),
        ("Перенести на 20 ноября ２０２７ года в 19:00", "year", "invalid"),
        ("Перенести на 20 ноября, 2027 в 19:00", "year", "invalid"),
        ("Перенести на 20.11 2027 в 19:00", "year", "invalid"),
        ("Перенести на 20 ноябрябрь в 19:00", "date", "missing"),
    ],
)
def test_unsupported_or_ambiguous_forms_never_silently_become_dates(
    prompt: str, field: str, reason: str
) -> None:
    result = resolve_date(state(prompt), event(), datetime(2026, 10, 27, tzinfo=UTC))
    assert result.start is None
    assert any(item.field == field and item.reason == reason for item in result.clarifications)


def test_iso_preserves_explicit_seconds_and_fraction_when_normalizing_offset() -> None:
    result = resolve_date(
        state("Перенести на 2027-11-20T16:00:30.125Z"), event(), datetime(2026, 10, 27, tzinfo=UTC)
    )
    assert result.start is not None
    assert result.start.isoformat() == "2027-11-20T19:00:30.125000+03:00"


def test_non_leap_default_year_asks_year_without_losing_valid_february_29() -> None:
    result = resolve_date(
        state("Перенести на 29 февраля в 19:00"), event(2027), datetime(2027, 1, 1, tzinfo=UTC)
    )
    assert result.start is None
    assert any(item.field == "year" and item.reason == "invalid" for item in result.clarifications)
    assert result.partial.year is None
    assert (result.partial.month, result.partial.day, result.partial.hour) == (2, 29, 19)
    assert result.year_source is None


def test_year_source_is_optional_nullable_and_legacy_state_remains_readable() -> None:
    schema = AssistantState.model_json_schema(mode="serialization")
    assert "year_source" not in schema["required"]
    assert "partial_date" in schema["required"]
    options = schema["properties"]["year_source"]["anyOf"]
    assert {"type": "null"} in options
    values = next(item["enum"] for item in options if item.get("type") == "string")
    assert set(values) == {"explicit", "current_year", "clarification", "manual"}
    legacy = state("Старый запрос").model_dump(mode="json")
    legacy.pop("year_source")
    assert AssistantState.model_validate(legacy).year_source is None


def test_time_immediately_after_partial_date_is_not_mistaken_for_a_short_year() -> None:
    result = resolve_date(
        state("Перенести на 20 ноября 19:00"), event(), datetime(2026, 10, 27, tzinfo=UTC)
    )
    assert result.start is not None
    assert result.start.isoformat() == "2026-11-20T19:00:00+03:00"


@pytest.mark.parametrize(
    "prompt",
    [
        "Перенести Керамику на 20-21.11.2027 в 19:00",
        "Перенести Керамику на 20–21.11.2027 в 19:00",
        "Перенести Керамику на 20—21.11.2027 в 19:00",
        "Перенести Керамику на 20 ноября 2027-2028 года в 19:00",
        "Перенести Керамику с20 на21 ноября2027 в 19:00",
    ],
)
def test_review_shorthand_ranges_require_explicit_target_date(prompt: str) -> None:
    result = resolve_date(state(prompt), event(), datetime(2026, 10, 27, tzinfo=UTC))
    assert result.start is None
    assert any(
        item.field == "date" and item.reason == "ambiguous" for item in result.clarifications
    )


@pytest.mark.parametrize("date", ["2027-11-20", "20.11.2027", "20 ноября 2027"])
def test_review_normal_dates_and_iso_hyphens_are_not_ranges(date: str) -> None:
    result = resolve_date(
        state(f"Перенести Керамику на {date} в 19:00"), event(), datetime(2026, 10, 27, tzinfo=UTC)
    )
    assert result.start is not None
    assert result.start.isoformat() == "2027-11-20T19:00:00+03:00"
    assert result.clarifications == []


def test_persisted_default_year_is_revalidated_against_selected_event_year() -> None:
    saved = state("Перенести на 20 ноября в 19:00")
    saved.partial_date = partial_from_start(datetime.fromisoformat("2026-11-20T19:00:00+03:00"))
    saved.year_source = "current_year"
    result = resolve_date(saved, event(2027), datetime(2026, 10, 27, tzinfo=UTC))
    assert result.start is None
    assert [(item.field, item.reason) for item in result.clarifications] == [("year", "conflict")]
    assert result.partial == saved.partial_date
    assert result.year_source == "current_year"


@pytest.mark.parametrize("source", ["explicit", "clarification", "manual"])
def test_authoritative_year_survives_incompatible_event_year(source: str) -> None:
    saved = state("Перенести на 20 ноября в 19:00")
    if source == "explicit":
        saved.original_prompt = "Перенести на 20 ноября 2026 в 19:00"
    elif source == "clarification":
        saved.answers = AssistantAnswers(year=2026)
    else:
        saved.partial_date = partial_from_start(datetime.fromisoformat("2026-11-20T19:00:00+03:00"))
        saved.manual_fields = ["date"]
    result = resolve_date(saved, event(2027), datetime(2026, 10, 27, tzinfo=UTC))
    assert result.start is not None
    assert result.start.isoformat() == "2026-11-20T19:00:00+03:00"
    assert result.year_source == source
    assert result.clarifications == []
