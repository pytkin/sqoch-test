"""Validated synthetic events and purchases, without a second persistence layer."""

from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo

from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    EmailStr,
    StringConstraints,
    field_validator,
    model_validator,
)

Nonempty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, strict=True)]
DEFAULT_FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "demo.json"


def utc_text(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


class FixtureEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Nonempty
    title: Nonempty
    starts_at: AwareDatetime
    timezone: Literal["Europe/Moscow"]

    @field_validator("starts_at")
    @classmethod
    def require_moscow_offset(cls, value: datetime) -> datetime:
        if value.utcoffset() != value.astimezone(ZoneInfo("Europe/Moscow")).utcoffset():
            raise ValueError("Event date must explicitly use the Europe/Moscow offset")
        return value


class FixturePurchase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Nonempty
    event_id: Nonempty
    email: EmailStr
    status: Literal["active", "cancelled"]

    @field_validator("email", mode="before")
    @classmethod
    def trim_email(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @property
    def normalized_email(self) -> str:
        return str(self.email).lower()


class DemoFixture(BaseModel):
    model_config = ConfigDict(extra="forbid")

    events: list[FixtureEvent]
    purchases: list[FixturePurchase]

    @model_validator(mode="after")
    def validate_identity_and_references(self) -> Self:
        event_ids = {event.id for event in self.events}
        purchase_ids = {purchase.id for purchase in self.purchases}
        if len(event_ids) != len(self.events) or len(purchase_ids) != len(self.purchases):
            raise ValueError("Fixture IDs must be unique within each collection")
        if any(purchase.event_id not in event_ids for purchase in self.purchases):
            raise ValueError("Every purchase must refer to an event in the fixture")
        return self


def read_fixture(path: Path) -> DemoFixture:
    return DemoFixture.model_validate_json(path.read_text(encoding="utf8"))
