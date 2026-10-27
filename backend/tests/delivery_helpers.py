"""Small real-database setup shared by delivery boundary tests."""

from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from sqoch_api.notifications import service
from sqoch_api.notifications.fixtures import DEFAULT_FIXTURE
from sqoch_api.notifications.schemas import (
    ConfirmCampaignRequest,
    PreviewRequest,
    SaveCampaignRequest,
)
from sqoch_api.notifications.store import init_db, load_demo

NOW = datetime(2026, 10, 26, 12, tzinfo=UTC)


def confirmed_campaign(path: Path) -> UUID:
    init_db(path)
    load_demo(path, DEFAULT_FIXTURE)
    campaign_id = uuid4()
    service.create_campaign(path, campaign_id, lambda: NOW)
    service.save_campaign(
        path,
        campaign_id,
        SaveCampaignRequest.model_validate(
            {
                "expected_revision": 0,
                "event_id": "ceramics",
                "proposed_start": "2099-11-20T19:00:00+03:00",
                "subject": "Перенос",
                "body": "Новая дата мастер-класса",
                "text_reviewed": True,
                "reviewed_event_revision": 0,
            }
        ),
        lambda: NOW,
    )
    preview = service.preview_campaign(
        path, campaign_id, PreviewRequest(expected_revision=1), lambda: NOW
    )
    service.confirm_campaign(
        path, campaign_id, ConfirmCampaignRequest(preview_token=preview.token), lambda: NOW
    )
    return campaign_id
