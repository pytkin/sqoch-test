"""Connection-scoped reads and public campaign projections; never commit here."""

import json
import sqlite3
from typing import cast

from sqoch_api.notifications.assistant_state import AssistantState
from sqoch_api.notifications.errors import OrganizerError
from sqoch_api.notifications.schemas import (
    CampaignCounters,
    CampaignDelivery,
    CampaignDetail,
    CampaignPreview,
    CampaignStatus,
    EventSnapshot,
    OrganizerEvent,
)


def campaign_row(connection: sqlite3.Connection, campaign_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
    if row is None:
        raise OrganizerError(404, "not_found", "Рассылка не найдена")
    return cast(sqlite3.Row, row)


def event_row(connection: sqlite3.Connection, event_id: str) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if row is None:
        raise OrganizerError(404, "not_found", "Мероприятие не найдено")
    return cast(sqlite3.Row, row)


def event_model(row: sqlite3.Row) -> OrganizerEvent:
    return OrganizerEvent.model_validate(
        {**dict(row), "starts_at": row["starts_at_utc"]}, extra="ignore"
    )


def campaign_detail(connection: sqlite3.Connection, row: sqlite3.Row) -> CampaignDetail:
    deliveries = [
        CampaignDelivery.model_validate(
            {
                "id": item["id"],
                "email": item["email"],
                "state": item["state"],
                "attempts": item["attempts"],
                "next_attempt_at": item["next_attempt_at"],
                "sent_at": item["sent_at"],
                "error_code": item["last_error_code"],
                "error_message": item["last_error_message"],
            }
        )
        for item in connection.execute(
            "SELECT * FROM deliveries WHERE campaign_id=? ORDER BY email", (row["id"],)
        )
    ]
    counts = {
        state: sum(item.state == state for item in deliveries)
        for state in ("pending", "sending", "retry_wait", "sent", "failed", "unknown")
    }
    counters = CampaignCounters(total=len(deliveries), **counts)
    status: CampaignStatus = "draft"
    if row["phase"] == "confirmed":
        if counters.pending or counters.sending or counters.retry_wait:
            status = "processing"
        elif counters.unknown:
            status = "needs_attention"
        elif counters.failed:
            status = "completed_with_errors"
        else:
            status = "completed"
    preview = json.loads(row["preview_json"])["public"] if row["preview_json"] else None
    snapshot = json.loads(row["event_snapshot_json"]) if row["event_snapshot_json"] else None
    return CampaignDetail.model_validate(
        {
            **{
                key: row[key]
                for key in (
                    "id",
                    "phase",
                    "revision",
                    "created_at",
                    "updated_at",
                    "event_id",
                    "proposed_start",
                    "suggested_start",
                    "subject",
                    "body",
                    "text_reviewed",
                    "reviewed_event_revision",
                    "confirmed_at",
                )
            },
            "event_snapshot": EventSnapshot.model_validate(snapshot) if snapshot else None,
            "assistant_state": (
                AssistantState.model_validate_json(row["assistant_state_json"])
                if row["assistant_state_json"]
                else None
            ),
            "preview": CampaignPreview.model_validate(preview) if preview else None,
            "status": status,
            "counters": counters,
            "deliveries": deliveries,
        }
    )
