"""HTTP application entry point."""

import sqlite3
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from sqoch_api.notifications.ai_routes import ai_router
from sqoch_api.notifications.config import load_config
from sqoch_api.notifications.errors import DraftValidationError, OrganizerError
from sqoch_api.notifications.locks import maintenance_lock
from sqoch_api.notifications.routes import organizer_router
from sqoch_api.notifications.service import Clock, utc_now
from sqoch_api.notifications.store import init_db
from sqoch_api.orders import (
    ConfirmedOrder,
    Event,
    OrderRequest,
    Quote,
    SoldOut,
    SoldOutResponse,
    ValidationErrorResponse,
    quote_order,
)


def validation_error_response(_request: Request, error: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "detail": [
                {key: issue[key] for key in ("loc", "msg", "type")} for issue in error.errors()
            ]
        },
    )


def create_app(
    frontend_dir: Path | None = None,
    *,
    clock: Clock = utc_now,
    allowed_hosts: Sequence[str] = ("127.0.0.1", "localhost"),
    ai_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    config = load_config()

    @asynccontextmanager
    async def lifespan(_application: FastAPI) -> AsyncIterator[None]:
        init_db(config.database_path)
        with maintenance_lock(config.database_path):
            yield

    application = FastAPI(title="Sqoch API", version="0.1.0", lifespan=lifespan)
    application.exception_handler(RequestValidationError)(validation_error_response)

    @application.exception_handler(OrganizerError)
    def organizer_error(_request: Request, error: OrganizerError) -> JSONResponse:
        return JSONResponse(status_code=error.status, content={"detail": error.detail.model_dump()})

    @application.exception_handler(sqlite3.Error)
    def storage_error(_request: Request, _error: sqlite3.Error) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={
                "detail": {
                    "code": "storage_unavailable",
                    "message": "Не удалось сохранить данные. Повторите действие",
                    "related_campaign_id": None,
                }
            },
        )

    @application.exception_handler(DraftValidationError)
    def incomplete_draft(_request: Request, error: DraftValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422, content={"detail": [issue.model_dump() for issue in error.issues]}
        )

    @application.middleware("http")
    async def protect_local_organizer(
        request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if request.url.path.startswith("/api/organizer"):
            host = request.headers.get("host", "").split(":", 1)[0]
            code, status, message = "", 0, ""
            if host not in allowed_hosts:
                code, status, message = "host_not_allowed", 400, "Недопустимый адрес приложения"
            elif request.method not in {"GET", "HEAD", "OPTIONS"}:
                origin = request.headers.get("origin")
                if origin and origin not in {
                    "http://127.0.0.1:5173",
                    "http://127.0.0.1:8000",
                    "http://localhost:5173",
                    "http://localhost:8000",
                }:
                    code, status, message = (
                        "origin_not_allowed",
                        403,
                        "Запрос с этого сайта запрещён",
                    )
                elif request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
                    code, status, message = "json_required", 415, "Ожидаются данные JSON"
            if code:
                return JSONResponse(
                    status_code=status,
                    content={
                        "detail": {
                            "code": code,
                            "message": message,
                            "related_campaign_id": None,
                        }
                    },
                )
        return await call_next(request)

    application.include_router(organizer_router(config.database_path, clock))
    application.include_router(ai_router(config, clock, ai_transport))

    @application.get("/api/event")
    def get_event() -> Event:
        return Event()

    @application.post("/api/orders/quote", responses={422: {"model": ValidationErrorResponse}})
    def quote(order: OrderRequest) -> Quote:
        return quote_order(order)

    @application.post(
        "/api/orders",
        status_code=201,
        responses={409: {"model": SoldOutResponse}, 422: {"model": ValidationErrorResponse}},
    )
    def confirm(
        order: OrderRequest,
        demo_scenario: Annotated[
            Literal["success", "sold_out"], Header(alias="X-Demo-Scenario")
        ] = "success",
    ) -> ConfirmedOrder:
        quote = quote_order(order)
        if demo_scenario == "sold_out":
            raise HTTPException(status_code=409, detail=SoldOut().model_dump())
        return ConfirmedOrder(**quote.model_dump(), order_id=f"sqoch-{uuid4()}")

    built_frontend = (
        frontend_dir if frontend_dir is not None else Path(__file__).resolve().parents[2] / "dist"
    )
    if built_frontend.is_dir():
        application.mount("/", StaticFiles(directory=built_frontend, html=True), name="frontend")

    return application


app = create_app()
