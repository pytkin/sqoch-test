"""Organizer HTTP adapter over explicit transactional use cases."""

from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Response

from sqoch_api.notifications import delivery, service
from sqoch_api.notifications.config import load_config
from sqoch_api.notifications.mailpit import MailpitClient
from sqoch_api.notifications.schemas import (
    CampaignDetail,
    CampaignList,
    CampaignPreview,
    ConfirmCampaignRequest,
    CreateCampaignRequest,
    EmptyRequest,
    OrganizerErrorResponse,
    OrganizerEvents,
    OrganizerValidationResponse,
    PreviewRequest,
    SaveCampaignRequest,
)


def organizer_router(path: Path, clock: service.Clock) -> APIRouter:
    router = APIRouter(
        prefix="/api/organizer",
        responses={
            400: {"model": OrganizerErrorResponse},
            403: {"model": OrganizerErrorResponse},
            415: {"model": OrganizerErrorResponse},
            404: {"model": OrganizerErrorResponse},
            409: {"model": OrganizerErrorResponse},
            422: {"model": OrganizerValidationResponse},
            503: {"model": OrganizerErrorResponse},
        },
    )

    @router.get("/events")
    def events() -> OrganizerEvents:
        return service.list_events(path)

    @router.get("/campaigns")
    def campaigns() -> CampaignList:
        return service.list_campaigns(path)

    @router.get("/campaigns/{campaign_id}")
    def campaign(campaign_id: UUID) -> CampaignDetail:
        return service.get_campaign(path, campaign_id)

    @router.put(
        "/campaigns/{campaign_id}", status_code=201, responses={200: {"model": CampaignDetail}}
    )
    def create(
        campaign_id: UUID, request: CreateCampaignRequest, response: Response
    ) -> CampaignDetail:
        detail, inserted = service.create_campaign(path, campaign_id, clock, request)
        if not inserted:
            response.status_code = 200
        return detail

    @router.patch("/campaigns/{campaign_id}")
    def save(campaign_id: UUID, request: SaveCampaignRequest) -> CampaignDetail:
        return service.save_campaign(path, campaign_id, request, clock)

    @router.post("/campaigns/{campaign_id}/preview")
    def preview(campaign_id: UUID, request: PreviewRequest) -> CampaignPreview:
        return service.preview_campaign(path, campaign_id, request, clock)

    @router.post(
        "/campaigns/{campaign_id}/confirm",
        status_code=202,
        responses={200: {"model": CampaignDetail}},
    )
    def confirm(
        campaign_id: UUID, request: ConfirmCampaignRequest, response: Response
    ) -> CampaignDetail:
        detail, inserted = service.confirm_campaign(path, campaign_id, request, clock)
        if not inserted:
            response.status_code = 200
        return detail

    @router.post("/campaigns/{campaign_id}/resume")
    def resume(campaign_id: UUID, request: EmptyRequest) -> CampaignDetail:
        return delivery.resume_campaign(path, campaign_id, clock)

    @router.post("/campaigns/{campaign_id}/reconcile")
    def reconcile(campaign_id: UUID, request: EmptyRequest) -> CampaignDetail:
        checker = MailpitClient(load_config().mailpit_url)
        return delivery.reconcile_campaign(path, campaign_id, checker.check, clock)

    return router
