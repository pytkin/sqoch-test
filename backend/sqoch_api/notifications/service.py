"""Small transactional organizer use cases; no SMTP or LLM side effects."""

import json
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from email import policy
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path
from uuid import UUID, uuid4

from sqoch_api.notifications import campaign_queries, preparation_drafts
from sqoch_api.notifications.errors import (
    DraftValidationError,
    OrganizerError,
    require_draft_revision,
)
from sqoch_api.notifications.fixtures import utc_text
from sqoch_api.notifications.schemas import (
    CampaignDetail,
    CampaignList,
    CampaignPreview,
    CampaignSummary,
    ConfirmCampaignRequest,
    CreateCampaignRequest,
    EventSnapshot,
    OrganizerEvent,
    OrganizerEvents,
    PreviewRequest,
    SaveCampaignRequest,
)
from sqoch_api.notifications.store import connect_db, get_events, recipient_emails
from sqoch_api.orders import ValidationIssue

Clock = Callable[[], datetime]


def utc_now() -> datetime:
    return datetime.now(UTC)


def list_events(path: Path) -> OrganizerEvents:
    return OrganizerEvents(items=[OrganizerEvent.model_validate(row) for row in get_events(path)])


def get_campaign(path: Path, campaign_id: UUID) -> CampaignDetail:
    with connect_db(path) as connection:
        connection.execute("BEGIN")
        return campaign_queries.campaign_detail(
            connection, campaign_queries.campaign_row(connection, str(campaign_id))
        )


def create_campaign(
    path: Path,
    campaign_id: UUID,
    clock: Clock,
    request: CreateCampaignRequest | None = None,
) -> tuple[CampaignDetail, bool]:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT * FROM campaigns WHERE id=?", (str(campaign_id),)
        ).fetchone()
        if existing is not None:
            return campaign_queries.campaign_detail(connection, existing), False
        request = request if request is not None else CreateCampaignRequest()
        for candidate_id in {request.event_id, request.context_event_id}:
            if candidate_id is not None:
                campaign_queries.event_row(connection, candidate_id)
        event_id = request.event_id or (request.context_event_id if request.prompt else None)
        state = preparation_drafts.create_state(request, event_id)
        now = utc_text(clock())
        connection.execute(
            "INSERT INTO campaigns(id,created_at,updated_at,event_id,proposed_start,subject,body,"
            "prompt,assistant_state_json) VALUES (?,?,?,?,?,?,?,?,?)",
            (
                str(campaign_id),
                now,
                now,
                event_id,
                utc_text(request.proposed_start) if request.proposed_start else None,
                request.subject,
                request.body,
                request.prompt,
                state.model_dump_json() if state else None,
            ),
        )
        return campaign_queries.campaign_detail(
            connection, campaign_queries.campaign_row(connection, str(campaign_id))
        ), True


def list_campaigns(path: Path) -> CampaignList:
    with connect_db(path) as connection:
        connection.execute("BEGIN")
        rows = connection.execute("SELECT * FROM campaigns ORDER BY created_at DESC,id").fetchall()
        items = []
        for row in rows:
            detail = campaign_queries.campaign_detail(connection, row)
            meaningful = preparation_drafts.has_content(row, detail.assistant_state)
            stage = None
            if detail.phase == "draft":
                stage = (
                    "empty"
                    if not meaningful
                    else (detail.assistant_state.stage if detail.assistant_state else "manual")
                )
            title = None
            if detail.event_snapshot:
                title = detail.event_snapshot.title
            elif detail.event_id:
                title = str(campaign_queries.event_row(connection, detail.event_id)["title"])
            items.append(
                CampaignSummary.model_validate(
                    {
                        **detail.model_dump(
                            include={
                                "id",
                                "phase",
                                "revision",
                                "created_at",
                                "updated_at",
                                "event_id",
                                "subject",
                                "proposed_start",
                                "status",
                                "counters",
                            }
                        ),
                        "event_title": title,
                        "has_content": meaningful,
                        "preparation_stage": stage,
                        "event_snapshot": detail.event_snapshot,
                    }
                )
            )
        return CampaignList(items=items)


def save_campaign(
    path: Path, campaign_id: UUID, request: SaveCampaignRequest, clock: Clock
) -> CampaignDetail:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = campaign_queries.campaign_row(connection, str(campaign_id))
        require_draft_revision(row["phase"], row["revision"], request.expected_revision)
        event = (
            campaign_queries.event_row(connection, request.event_id) if request.event_id else None
        )
        if request.text_reviewed and (
            event is None
            or request.proposed_start is None
            or not request.subject
            or not request.body
            or request.reviewed_event_revision != event["revision"]
        ):
            raise OrganizerError(
                409, "text_review_required", "Проверьте текст по актуальным данным мероприятия"
            )
        state = preparation_drafts.saved_state(row, request)
        if request.prompt == "" and state is not None and state.mode != "manual":
            raise DraftValidationError(
                [
                    ValidationIssue(
                        loc=["body", "prompt"],
                        msg="Очистить запрос можно при ручном сохранении",
                        type="value_error",
                    )
                ]
            )
        connection.execute(
            "UPDATE campaigns SET revision=revision+1,updated_at=?,event_id=?,proposed_start=?,"
            "subject=?,body=?,text_reviewed=?,reviewed_event_revision=?,"
            "preview_json=NULL,assistant_state_json=?,prompt=? WHERE id=?",
            (
                utc_text(clock()),
                request.event_id,
                utc_text(request.proposed_start) if request.proposed_start else None,
                request.subject,
                request.body,
                request.text_reviewed,
                request.reviewed_event_revision if request.text_reviewed else None,
                state.model_dump_json() if state else None,
                state.original_prompt if state else row["prompt"],
                str(campaign_id),
            ),
        )
        return campaign_queries.campaign_detail(
            connection, campaign_queries.campaign_row(connection, str(campaign_id))
        )


def _require_reviewed_complete(
    connection: sqlite3.Connection, row: sqlite3.Row, now: datetime
) -> sqlite3.Row:
    missing = [name for name in ("event_id", "proposed_start", "subject", "body") if not row[name]]
    if missing:
        raise DraftValidationError(
            [
                ValidationIssue(
                    loc=["body", name], msg="Заполните поле", type="missing_draft_value"
                )
                for name in missing
            ]
        )
    event = campaign_queries.event_row(connection, row["event_id"])
    if not row["text_reviewed"] or row["reviewed_event_revision"] != event["revision"]:
        raise OrganizerError(
            409, "text_review_required", "Проверьте текст по актуальным данным мероприятия"
        )
    proposed = datetime.fromisoformat(row["proposed_start"])
    if proposed <= now:
        raise OrganizerError(422, "date_not_future", "Укажите будущую дату мероприятия")
    if proposed == datetime.fromisoformat(event["starts_at_utc"]):
        raise OrganizerError(422, "date_unchanged", "Новая дата совпадает с текущей")
    return event


def _source_snapshot(connection: sqlite3.Connection, event: sqlite3.Row) -> dict[str, object]:
    return {
        "event": dict(event),
        "purchases": [
            dict(item)
            for item in connection.execute(
                "SELECT id,event_id,email,normalized_email,status FROM purchases "
                "WHERE event_id=? ORDER BY id",
                (event["id"],),
            )
        ],
    }


def preview_campaign(
    path: Path, campaign_id: UUID, request: PreviewRequest, clock: Clock
) -> CampaignPreview:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = campaign_queries.campaign_row(connection, str(campaign_id))
        require_draft_revision(row["phase"], row["revision"], request.expected_revision)
        event = _require_reviewed_complete(connection, row, clock())
        recipients = recipient_emails(connection, event["id"])
        if not recipients:
            raise OrganizerError(422, "no_recipients", "Нет покупателей с действующими покупками")
        source = _source_snapshot(connection, event)
        if row["preview_json"]:
            existing = json.loads(row["preview_json"])
            if existing["source"] == source:
                return CampaignPreview.model_validate(existing["public"])
        preview = CampaignPreview.model_validate(
            {
                "token": uuid4(),
                "campaign_id": campaign_id,
                "draft_revision": row["revision"],
                "event": campaign_queries.event_model(event),
                "old_start": event["starts_at_utc"],
                "proposed_start": row["proposed_start"],
                "subject": row["subject"],
                "body": row["body"],
                "recipients": recipients,
            }
        )
        stored = {"public": preview.model_dump(mode="json"), "source": source}
        connection.execute(
            "UPDATE campaigns SET preview_json=? WHERE id=?",
            (json.dumps(stored, ensure_ascii=False), str(campaign_id)),
        )
        return preview


def _insert_delivery(
    connection: sqlite3.Connection,
    campaign_id: str,
    recipient: str,
    subject: str,
    body: str,
    now: datetime,
) -> None:
    delivery_id = str(uuid4())
    message_id = f"delivery-{delivery_id}@sqoch.local"
    message = EmailMessage()
    message["From"] = "Sqoch <organizer@example.com>"
    message["To"] = recipient
    message["Subject"] = subject
    message["Message-ID"] = f"<{message_id}>"
    message["X-Sqoch-Campaign-ID"] = campaign_id
    message["Date"] = format_datetime(now.astimezone(UTC))
    message.set_content(body)
    connection.execute(
        "INSERT INTO deliveries(id,campaign_id,email,message_id,mime,created_at) "
        "VALUES (?,?,?,?,?,?)",
        (
            delivery_id,
            campaign_id,
            recipient,
            message_id,
            message.as_bytes(policy=policy.SMTP),
            utc_text(now),
        ),
    )


def confirm_campaign(
    path: Path, campaign_id: UUID, request: ConfirmCampaignRequest, clock: Clock
) -> tuple[CampaignDetail, bool]:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = campaign_queries.campaign_row(connection, str(campaign_id))
        token = str(request.preview_token)
        if row["phase"] == "confirmed":
            if row["accepted_token"] != token:
                raise OrganizerError(409, "confirmation_conflict", "Эта рассылка уже подтверждена")
            return campaign_queries.campaign_detail(connection, row), False
        if not row["preview_json"]:
            raise OrganizerError(409, "preview_stale", "Проверьте рассылку перед подтверждением")
        saved = json.loads(row["preview_json"])
        preview = CampaignPreview.model_validate(saved["public"])
        if str(preview.token) != token or preview.draft_revision != row["revision"]:
            raise OrganizerError(
                409, "preview_stale", "Предпросмотр изменился. Проверьте рассылку заново"
            )
        now = clock()
        event = _require_reviewed_complete(connection, row, now)
        if saved["source"] != _source_snapshot(connection, event):
            raise OrganizerError(
                409, "preview_stale", "Данные изменились. Проверьте рассылку заново"
            )
        recipients = recipient_emails(connection, event["id"])
        if not recipients:
            raise OrganizerError(422, "no_recipients", "Нет покупателей с действующими покупками")
        unsettled = connection.execute(
            "SELECT c.id FROM campaigns c JOIN deliveries d ON d.campaign_id=c.id "
            "WHERE c.id<>? AND c.event_id=? AND c.phase='confirmed' "
            "AND d.state IN ('pending','sending','retry_wait','unknown') LIMIT 1",
            (str(campaign_id), event["id"]),
        ).fetchone()
        if unsettled:
            raise OrganizerError(
                409,
                "event_campaign_unsettled",
                "Сначала завершите предыдущую рассылку этого мероприятия",
                str(unsettled[0]),
            )
        snapshot = EventSnapshot.model_validate(
            {
                "id": event["id"],
                "title": event["title"],
                "old_start": event["starts_at_utc"],
                "new_start": row["proposed_start"],
                "timezone": event["timezone"],
                "event_revision_before": event["revision"],
            }
        )
        connection.execute(
            "UPDATE events SET starts_at_utc=?,revision=revision+1 WHERE id=?",
            (row["proposed_start"], event["id"]),
        )
        connection.execute(
            "UPDATE campaigns SET phase='confirmed',revision=revision+1,"
            "updated_at=?,confirmed_at=?,"
            "event_snapshot_json=?,accepted_token=? WHERE id=?",
            (utc_text(now), utc_text(now), snapshot.model_dump_json(), token, str(campaign_id)),
        )
        for recipient in recipients:
            _insert_delivery(
                connection, str(campaign_id), recipient, row["subject"], row["body"], now
            )
        return campaign_queries.campaign_detail(
            connection, campaign_queries.campaign_row(connection, str(campaign_id))
        ), True
