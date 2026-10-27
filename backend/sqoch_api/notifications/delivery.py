"""Durable delivery state transitions; SMTP is invoked only after claim commit."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

from sqoch_api.notifications import campaign_queries, service
from sqoch_api.notifications.errors import OrganizerError
from sqoch_api.notifications.fixtures import utc_text
from sqoch_api.notifications.schemas import CampaignDetail
from sqoch_api.notifications.smtp import SendResult
from sqoch_api.notifications.store import connect_db

if TYPE_CHECKING:
    from sqoch_api.notifications.mailpit import MatchResult

RETRY_DELAYS = (5, 15, 60, 120)


@dataclass(frozen=True)
class DeliveryJob:
    id: str
    campaign_id: str
    email: str
    attempts: int
    message_id: str
    mime: bytes


def claim_next(path: Path, now: datetime) -> DeliveryJob | None:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT * FROM deliveries WHERE attempts<5 AND (state='pending' OR "
            "(state='retry_wait' AND next_attempt_at<=?)) ORDER BY created_at,id LIMIT 1",
            (utc_text(now),),
        ).fetchone()
        if row is None:
            return None
        changed = connection.execute(
            "UPDATE deliveries SET state='sending',attempts=attempts+1,next_attempt_at=NULL "
            "WHERE id=? AND state=? AND attempts=?",
            (row["id"], row["state"], row["attempts"]),
        ).rowcount
        if changed != 1:
            return None
        return DeliveryJob(
            id=str(row["id"]),
            campaign_id=str(row["campaign_id"]),
            email=str(row["email"]),
            attempts=int(row["attempts"]) + 1,
            message_id=str(row["message_id"]),
            mime=bytes(row["mime"]),
        )


def recover_sending(path: Path) -> int:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        return connection.execute(
            "UPDATE deliveries SET state='unknown',next_attempt_at=NULL,"
            "last_error_code='worker_interrupted',last_error_message=? WHERE state='sending'",
            ("Результат отправки требует проверки",),
        ).rowcount


def record_result(path: Path, job: DeliveryJob, result: SendResult, now: datetime) -> None:
    state = result.state
    code, message = result.code, result.message
    next_attempt = None
    if state == "retry_wait":
        if job.attempts >= 5:
            state = "failed"
            code, message = "attempts_exhausted", "Не отправлено: исчерпан лимит попыток"
        else:
            next_attempt = utc_text(now + timedelta(seconds=RETRY_DELAYS[job.attempts - 1]))
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "UPDATE deliveries SET state=?,next_attempt_at=?,last_error_code=?,"
            "last_error_message=?,sent_at=? WHERE id=? AND state='sending' AND attempts=?",
            (
                state,
                next_attempt,
                code,
                message,
                utc_text(now) if state == "sent" else None,
                job.id,
                job.attempts,
            ),
        )


def process_one(
    path: Path, sender: Callable[[DeliveryJob], SendResult], clock: service.Clock = service.utc_now
) -> bool:
    job = claim_next(path, clock())
    if job is None:
        return False
    try:
        result = sender(job)
    except Exception:
        result = SendResult("unknown", "sender_exception", "Результат отправки требует проверки")
    record_result(path, job, result, clock())
    return True


def resume_campaign(path: Path, campaign_id: UUID, clock: service.Clock) -> CampaignDetail:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = campaign_queries.campaign_row(connection, str(campaign_id))
        if row["phase"] != "confirmed":
            raise OrganizerError(409, "campaign_not_confirmed", "Сначала подтвердите рассылку")
        connection.execute(
            "UPDATE deliveries SET next_attempt_at=? WHERE campaign_id=? "
            "AND state='retry_wait' AND attempts<5",
            (utc_text(clock()), str(campaign_id)),
        )
        return campaign_queries.campaign_detail(connection, row)


def reconcile_campaign(
    path: Path,
    campaign_id: UUID,
    checker: Callable[[DeliveryJob], MatchResult],
    clock: service.Clock = service.utc_now,
) -> CampaignDetail:
    with connect_db(path) as connection:
        connection.execute("BEGIN")
        campaign = campaign_queries.campaign_row(connection, str(campaign_id))
        if campaign["phase"] != "confirmed":
            raise OrganizerError(409, "campaign_not_confirmed", "Сначала подтвердите рассылку")
        rows = connection.execute(
            "SELECT * FROM deliveries WHERE campaign_id=? AND state='unknown' ORDER BY email",
            (str(campaign_id),),
        ).fetchall()
    for row in rows:
        job = DeliveryJob(
            str(row["id"]),
            str(row["campaign_id"]),
            str(row["email"]),
            int(row["attempts"]),
            str(row["message_id"]),
            bytes(row["mime"]),
        )
        try:
            result = checker(job)
            code, mailpit_id = result.code, result.message_id
        except Exception:
            code, mailpit_id = "mailpit_unavailable", None
        with connect_db(path) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if code == "matched" and mailpit_id:
                connection.execute(
                    "UPDATE deliveries SET state='sent',sent_at=?,mailpit_message_id=?,"
                    "last_error_code=NULL,last_error_message=NULL WHERE id=? AND state='unknown'",
                    (utc_text(clock()), mailpit_id, job.id),
                )
            else:
                connection.execute(
                    "UPDATE deliveries SET last_error_code=?,last_error_message=? "
                    "WHERE id=? AND state='unknown'",
                    (
                        code if code != "matched" else "mailpit_unavailable",
                        "Результат отправки не подтверждён. Проверьте письма в Mailpit",
                        job.id,
                    ),
                )
    return service.get_campaign(path, campaign_id)
