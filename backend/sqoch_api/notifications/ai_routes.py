"""Two explicit draft-only AI actions."""

from uuid import UUID

import httpx
from fastapi import APIRouter

from sqoch_api.notifications.ai import prepare_campaign, rewrite_campaign
from sqoch_api.notifications.ai_schemas import AIActionResponse, PrepareRequest, RewriteRequest
from sqoch_api.notifications.config import NotificationConfig
from sqoch_api.notifications.schemas import OrganizerErrorResponse, OrganizerValidationResponse
from sqoch_api.notifications.service import Clock


def ai_router(
    config: NotificationConfig, clock: Clock, transport: httpx.AsyncBaseTransport | None = None
) -> APIRouter:
    router = APIRouter(
        prefix="/api/organizer/campaigns",
        responses={
            400: {"model": OrganizerErrorResponse},
            403: {"model": OrganizerErrorResponse},
            404: {"model": OrganizerErrorResponse},
            409: {"model": OrganizerErrorResponse},
            415: {"model": OrganizerErrorResponse},
            422: {"model": OrganizerValidationResponse},
            502: {"model": OrganizerErrorResponse},
            503: {"model": OrganizerErrorResponse},
            504: {"model": OrganizerErrorResponse},
        },
    )

    @router.post("/{campaign_id}/prepare")
    async def prepare(campaign_id: UUID, request: PrepareRequest) -> AIActionResponse:
        return await prepare_campaign(
            config,
            campaign_id,
            request,
            clock,
            transport=transport,
        )

    @router.post("/{campaign_id}/rewrite")
    async def rewrite(campaign_id: UUID, request: RewriteRequest) -> AIActionResponse:
        return await rewrite_campaign(
            config,
            campaign_id,
            request.expected_revision,
            request.instruction,
            clock,
            transport=transport,
        )

    return router
