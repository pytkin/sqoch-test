"""Validated order data and the single server-owned pricing rule."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

CHILD_AGE_LIMIT = 14
COMPANION_MIN_AGE = 18
MAX_PARTICIPANTS = 4
CHILD_TICKET_PRICE = 1000
FULL_TICKET_PRICE = 2000

Age = Annotated[int, Field(strict=True, ge=0)]
Currency = Literal["RUB"]
TicketType = Literal["child", "full"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class Participant(StrictModel):
    name: Annotated[str, Field(min_length=1)]
    age: Age

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class OrderRequest(StrictModel):
    participants: Annotated[list[Participant], Field(min_length=1, max_length=MAX_PARTICIPANTS)]
    email: EmailStr

    @field_validator("participants")
    @classmethod
    def require_companion_for_children(cls, participants: list[Participant]) -> list[Participant]:
        if any(person.age < CHILD_AGE_LIMIT for person in participants) and not any(
            person.age >= COMPANION_MIN_AGE for person in participants
        ):
            raise ValueError("Ребёнку младше 14 лет нужен сопровождающий от 18 лет в том же заказе")
        return participants


class PricedParticipant(Participant):
    ticket_type: TicketType
    price: int


class Quote(StrictModel):
    participants: list[PricedParticipant]
    email: EmailStr
    total: int
    currency: Currency = "RUB"


class ConfirmedOrder(Quote):
    order_id: str


class SoldOut(StrictModel):
    code: Literal["sold_out"] = "sold_out"
    message: str = "К сожалению, места закончились. Попробуйте другой демосценарий."


class SoldOutResponse(StrictModel):
    detail: SoldOut


class ValidationIssue(StrictModel):
    loc: list[str | int]
    msg: str
    type: str


class ValidationErrorResponse(StrictModel):
    detail: list[ValidationIssue]


class Event(StrictModel):
    id: str = "sqoch-event"
    title: str = "Мероприятие Sqoch"
    currency: Currency = "RUB"
    max_participants: int = MAX_PARTICIPANTS
    child_age_limit: int = CHILD_AGE_LIMIT
    companion_min_age: int = COMPANION_MIN_AGE
    full_ticket_price: int = FULL_TICKET_PRICE
    child_ticket_price: int = CHILD_TICKET_PRICE


def quote_order(order: OrderRequest) -> Quote:
    participants = [
        PricedParticipant(
            name=person.name,
            age=person.age,
            ticket_type="child" if person.age < CHILD_AGE_LIMIT else "full",
            price=CHILD_TICKET_PRICE if person.age < CHILD_AGE_LIMIT else FULL_TICKET_PRICE,
        )
        for person in order.participants
    ]
    return Quote(
        participants=participants,
        email=order.email,
        total=sum(person.price for person in participants),
    )
