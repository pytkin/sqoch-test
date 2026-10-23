"""HTTP application entry point."""

from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request

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


def create_app(frontend_dir: Path | None = None) -> FastAPI:
    application = FastAPI(title="Sqoch API", version="0.1.0")
    application.exception_handler(RequestValidationError)(validation_error_response)

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
