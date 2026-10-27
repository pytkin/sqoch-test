"""Short preparation intake/apply transactions; provider work belongs outside them."""

from typing import Literal
from uuid import UUID

from sqoch_api.notifications import campaign_queries, preparation_drafts
from sqoch_api.notifications.ai_schemas import AIActionResponse, PreparedContent, PrepareRequest
from sqoch_api.notifications.assistant_state import (
    AssistantAnswers,
    AssistantState,
    PartialDate,
    YearSource,
    partial_from_start,
)
from sqoch_api.notifications.config import NotificationConfig
from sqoch_api.notifications.date_resolver import Resolution, question
from sqoch_api.notifications.errors import (
    DraftValidationError,
    OrganizerError,
    require_draft_revision,
)
from sqoch_api.notifications.fixtures import utc_text
from sqoch_api.notifications.schemas import CampaignDetail
from sqoch_api.notifications.service import Clock
from sqoch_api.notifications.store import connect_db
from sqoch_api.orders import ValidationIssue


def intake(
    config: NotificationConfig, campaign_id: UUID, request: PrepareRequest, clock: Clock
) -> CampaignDetail:
    with connect_db(config.database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = campaign_queries.campaign_row(connection, str(campaign_id))
        require_draft_revision(row["phase"], row["revision"], request.expected_revision)
        previous = preparation_drafts.read_state(row)
        original = (
            request.prompt
            if request.prompt is not None
            else (previous.original_prompt if previous else row["prompt"])
        )
        if not original:
            raise DraftValidationError(
                [
                    ValidationIssue(
                        loc=["body", "prompt"],
                        msg="Введите запрос для подготовки",
                        type="missing_draft_value",
                    )
                ]
            )
        for event_id in {request.context_event_id, request.answers.event_id}:
            if event_id is not None:
                campaign_queries.event_row(connection, event_id)
        new_prompt = request.prompt is not None and request.prompt != (
            previous.original_prompt if previous else row["prompt"]
        )
        answers = previous.answers.model_dump() if previous and not new_prompt else {}
        if request.answers.date is not None and request.answers.year is None:
            answers.pop("year", None)
        answers.update(request.answers.model_dump())
        origins = list(previous.manual_fields) if previous else []
        context = previous.context_event_id if previous else row["event_id"]
        questions = []
        if request.answers.event_id is not None:
            context = request.answers.event_id
        elif context is None:
            context = request.context_event_id
        elif request.context_event_id is not None and request.context_event_id != context:
            questions.append(question("event_id", "conflict", request.context_event_id))
        partial = previous.partial_date if previous else partial_from_start(None)
        source: YearSource | None = previous.year_source if previous else None
        if new_prompt:
            parts = partial_from_start(None).model_dump()
            for field, names in (("date", ("year", "month", "day")), ("time", ("hour", "minute"))):
                if field in origins:
                    for name in names:
                        parts[name] = getattr(partial, name)
            partial = PartialDate.model_validate(parts)
            source = "manual" if "date" in origins and partial.year is not None else None
        state = AssistantState(
            version=1,
            mode="assistant",
            stage="intake",
            original_prompt=original,
            answers=AssistantAnswers.model_validate(answers),
            context_event_id=context,
            partial_date=partial,
            manual_fields=origins,
            clarifications=questions,
            intake_revision=row["revision"] + 1,
            applied_revision=previous.applied_revision if previous else None,
            year_source=source,
        )
        connection.execute(
            "UPDATE campaigns SET prompt=?,assistant_state_json=?,revision=revision+1,updated_at=?,"
            "text_reviewed=0,reviewed_event_revision=NULL,preview_json=NULL WHERE id=?",
            (original, state.model_dump_json(), utc_text(clock()), str(campaign_id)),
        )
        return campaign_queries.campaign_detail(
            connection, campaign_queries.campaign_row(connection, str(campaign_id))
        )


def mark_failed(config: NotificationConfig, campaign_id: UUID, revision: int) -> None:
    with connect_db(config.database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = campaign_queries.campaign_row(connection, str(campaign_id))
        if row["phase"] != "draft" or row["revision"] != revision:
            return
        state = preparation_drafts.read_state(row)
        if state is not None and state.intake_revision == revision:
            state.stage = "failed"
            connection.execute(
                "UPDATE campaigns SET assistant_state_json=? WHERE id=?",
                (state.model_dump_json(), str(campaign_id)),
            )


def apply_prepared(
    config: NotificationConfig,
    campaign_id: UUID,
    intake_revision: int,
    content: PreparedContent,
    resolution: Resolution,
    clock: Clock,
) -> AIActionResponse:
    with connect_db(config.database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = campaign_queries.campaign_row(connection, str(campaign_id))
        require_draft_revision(row["phase"], row["revision"], intake_revision)
        state = preparation_drafts.read_state(row)
        assert state is not None
        if content.status == "out_of_scope":
            state.stage = "failed"
            connection.execute(
                "UPDATE campaigns SET assistant_state_json=? WHERE id=?",
                (state.model_dump_json(), str(campaign_id)),
            )
            return AIActionResponse(
                outcome="out_of_scope",
                campaign=campaign_queries.campaign_detail(
                    connection, campaign_queries.campaign_row(connection, str(campaign_id))
                ),
                fields_to_complete=[],
                clarifications=[],
                message="Помощник готовит уведомления о переносе мероприятия",
            )
        selected = content.event_id
        questions = list(state.clarifications)
        if selected is not None:
            event = campaign_queries.event_row(connection, selected)
            if (
                (state.context_event_id is None or selected == state.context_event_id)
                and resolution.event_revision is not None
                and event["revision"] != resolution.event_revision
            ):
                raise OrganizerError(
                    409,
                    "text_review_required",
                    "Мероприятие изменилось. Подготовьте перенос заново",
                )
        if state.context_event_id and selected not in {state.context_event_id, None}:
            questions.append(question("event_id", "conflict", selected))
            selected = state.context_event_id
        elif selected is None and state.context_event_id:
            selected = state.context_event_id
        if selected is None or content.event_id is None:
            questions.append(question("event_id", "ambiguous"))
        questions.extend(resolution.clarifications)
        if resolution.start is not None and resolution.start <= clock():
            questions.append(
                question("year" if resolution.year_source == "current_year" else "date", "past")
            )
        questions = list({item.field: item for item in questions}.values())
        mismatch = any(item.field == "event_id" and item.reason == "conflict" for item in questions)
        proposed = utc_text(resolution.start) if resolution.start else None
        if (
            mismatch
            or any(item.reason == "conflict" for item in resolution.clarifications)
            and state.manual_fields
        ):
            proposed = row["proposed_start"]
        subject = row["subject"] if mismatch else (content.subject or row["subject"])
        body = row["body"] if mismatch else (content.body or row["body"])
        complete = bool(selected and proposed and subject and body and not questions)
        state.stage = "applied" if complete else "needs_input"
        state.context_event_id = selected
        state.partial_date = resolution.partial
        state.year_source = resolution.year_source
        state.clarifications = questions
        state.applied_revision = intake_revision + 1
        connection.execute(
            "UPDATE campaigns SET event_id=?,proposed_start=?,suggested_start=NULL,"
            "subject=?,body=?,"
            "assistant_state_json=?,revision=revision+1,updated_at=? WHERE id=?",
            (
                selected,
                proposed,
                subject,
                body,
                state.model_dump_json(),
                utc_text(clock()),
                str(campaign_id),
            ),
        )
        campaign = campaign_queries.campaign_detail(
            connection, campaign_queries.campaign_row(connection, str(campaign_id))
        )
        names: tuple[Literal["event_id", "proposed_start", "subject", "body"], ...] = (
            "event_id",
            "proposed_start",
            "subject",
            "body",
        )
        missing = [name for name in names if not getattr(campaign, name)]
        return AIActionResponse(
            outcome="applied" if complete else "needs_input",
            campaign=campaign,
            fields_to_complete=missing,
            clarifications=questions,
            message="Проверьте подготовленный перенос" if complete else "Уточните данные переноса",
        )
