"""Saved mode and manual origins for draft edits, independent of AI preparation."""

import sqlite3
from datetime import datetime

from sqoch_api.notifications.assistant_state import (
    AssistantAnswers,
    AssistantState,
    Clarification,
    ManualField,
    PartialDate,
    partial_from_start,
)
from sqoch_api.notifications.schemas import CreateCampaignRequest, SaveCampaignRequest

MANUAL_ORDER: tuple[ManualField, ...] = ("event_id", "date", "time")


def read_state(row: sqlite3.Row) -> AssistantState | None:
    return (
        AssistantState.model_validate_json(row["assistant_state_json"])
        if row["assistant_state_json"]
        else None
    )


def has_content(row: sqlite3.Row, state: AssistantState | None) -> bool:
    return bool(
        any(
            row[name]
            for name in (
                "prompt",
                "event_id",
                "proposed_start",
                "subject",
                "body",
                "suggested_start",
            )
        )
        or (state and state.original_prompt)
    )


def missing_context(
    event_id: str | None,
    start: datetime | None,
    partial: PartialDate | None = None,
) -> list[Clarification]:
    questions: list[Clarification] = []
    if not event_id:
        questions.append(Clarification(field="event_id", reason="missing", candidate_event_id=None))
    if start is None:
        date_complete = bool(partial and partial.year and partial.month and partial.day)
        if not date_complete:
            year_only = bool(partial and partial.month and partial.day and partial.year is None)
            questions.append(
                Clarification(
                    field="year" if year_only else "date", reason="missing", candidate_event_id=None
                )
            )
        if partial is None or partial.hour is None or partial.minute is None:
            questions.append(Clarification(field="time", reason="missing", candidate_event_id=None))
    return questions


def create_state(request: CreateCampaignRequest, event_id: str | None) -> AssistantState | None:
    if not request.model_fields_set:
        return None
    complete = bool(event_id and request.proposed_start and request.subject and request.body)
    manual = set(request.manual_fields)
    if "manual_fields" not in request.model_fields_set:
        if request.event_id:
            manual.add("event_id")
        if request.proposed_start:
            manual.update(("date", "time"))
    assistant = request.mode == "assistant"
    return AssistantState(
        version=1,
        mode=request.mode,
        stage="intake" if assistant else ("applied" if complete else "needs_input"),
        original_prompt=request.prompt,
        answers=AssistantAnswers(),
        context_event_id=request.context_event_id or event_id,
        partial_date=partial_from_start(request.proposed_start),
        manual_fields=[name for name in MANUAL_ORDER if name in manual],
        clarifications=[] if assistant else missing_context(event_id, request.proposed_start),
        intake_revision=0 if assistant else None,
        applied_revision=0 if complete and not assistant else None,
        year_source="manual" if "date" in manual and request.proposed_start else None,
    )


def saved_state(row: sqlite3.Row, request: SaveCampaignRequest) -> AssistantState | None:
    previous = read_state(row)
    original = previous.original_prompt if previous else row["prompt"]
    prompt_changed = request.prompt is not None and request.prompt != original
    old_start = datetime.fromisoformat(row["proposed_start"]) if row["proposed_start"] else None
    old_parts = partial_from_start(old_start)
    new_parts = partial_from_start(request.proposed_start)
    changed: set[ManualField] = set()
    if row["event_id"] != request.event_id:
        changed.add("event_id")
    if (old_parts.year, old_parts.month, old_parts.day) != (
        new_parts.year,
        new_parts.month,
        new_parts.day,
    ):
        changed.add("date")
    if (old_parts.hour, old_parts.minute) != (new_parts.hour, new_parts.minute):
        changed.add("time")
    touched = set(request.manual_fields) if "manual_fields" in request.model_fields_set else changed
    content_changed = bool(
        changed or request.subject != row["subject"] or request.body != row["body"]
    )
    if (
        previous is None
        and not content_changed
        and not prompt_changed
        and not (request.model_fields_set & {"mode", "manual_fields", "prompt"})
    ):
        return None
    mode = (
        request.mode
        if "mode" in request.model_fields_set
        else (previous.mode if previous else "manual")
    )
    origins = set(previous.manual_fields if previous else ()) | touched
    parts = (previous.partial_date if previous else old_parts).model_dump()
    answers = previous.answers.model_dump() if previous else {}
    partial_edits = changed | touched
    if request.proposed_start is None and touched & {"date", "time"}:
        # A date-only clear makes the combined timestamp null without clearing the clock control.
        partial_edits = (partial_edits - {"date", "time"}) | (touched & {"date", "time"})
    for field, components in (("date", ("year", "month", "day")), ("time", ("hour", "minute"))):
        if field in partial_edits:
            for name in components:
                parts[name] = getattr(new_parts, name)
            answers.pop(field, None)
            if field == "date":
                answers.pop("year", None)
    context = previous.context_event_id if previous else request.event_id
    if "event_id" in changed or "event_id" in touched:
        context = request.event_id
        answers.pop("event_id", None)
        if request.event_id:
            answers["event_id"] = request.event_id
    if prompt_changed:
        answers = {}
        retained = partial_from_start(None).model_dump()
        for field, components in (("date", ("year", "month", "day")), ("time", ("hour", "minute"))):
            if field in origins:
                for name in components:
                    retained[name] = parts[name]
        parts = retained
    complete = bool(
        request.event_id and request.proposed_start and request.subject and request.body
    )
    stage = previous.stage if previous else "needs_input"
    if mode == "manual" or content_changed:
        stage = "applied" if complete else "needs_input"
    elif prompt_changed:
        stage = "intake"
    partial = PartialDate.model_validate(parts)
    questions = previous.clarifications if previous else []
    if stage == "needs_input":
        unchanged_assistant = (
            previous is not None
            and previous.mode == mode == "assistant"
            and not partial_edits
            and not prompt_changed
        )
        # Resolver questions also carry ambiguity, past-date and event candidates.
        # Saving the same input must not replace them with generic missing fields.
        if not unchanged_assistant:
            questions = missing_context(request.event_id, request.proposed_start, partial)
    elif stage == "applied" or prompt_changed:
        questions = []
    return AssistantState(
        version=1,
        mode=mode,
        stage=stage,
        original_prompt=request.prompt if request.prompt is not None else original,
        answers=AssistantAnswers.model_validate(answers),
        context_event_id=context,
        partial_date=partial,
        manual_fields=[name for name in MANUAL_ORDER if name in origins],
        clarifications=questions,
        intake_revision=(
            row["revision"] + 1
            if prompt_changed and mode == "assistant"
            else (previous.intake_revision if previous else None)
        ),
        applied_revision=(
            row["revision"] + 1
            if complete and stage == "applied"
            else (previous.applied_revision if previous else None)
        ),
        year_source=(
            "manual"
            if ("date" in partial_edits or prompt_changed and "date" in origins)
            and partial.year is not None
            else (previous.year_source if previous and partial.year is not None else None)
        ),
    )
