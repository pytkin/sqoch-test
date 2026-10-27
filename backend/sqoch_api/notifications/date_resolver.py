"""Conservative deterministic transfer-date resolution from explicit input only."""

import re
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from pydantic import ValidationError

from sqoch_api.notifications.assistant_state import (
    AssistantState,
    Clarification,
    PartialDate,
    YearSource,
    partial_from_start,
)
from sqoch_api.notifications.schemas import MOSCOW, OrganizerEvent

MONTHS = {
    "января": 1,
    "январь": 1,
    "февраля": 2,
    "февраль": 2,
    "марта": 3,
    "март": 3,
    "апреля": 4,
    "апрель": 4,
    "мая": 5,
    "май": 5,
    "июня": 6,
    "июнь": 6,
    "июля": 7,
    "июль": 7,
    "августа": 8,
    "август": 8,
    "сентября": 9,
    "сентябрь": 9,
    "октября": 10,
    "октябрь": 10,
    "ноября": 11,
    "ноябрь": 11,
    "декабря": 12,
    "декабрь": 12,
}
ISO = re.compile(
    r"(?<![0-9])[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})(?![0-9])"
)
ISO_DAY = re.compile(r"(?<![0-9])(?P<year>[0-9]{4})-(?P<month>[0-9]{2})-(?P<day>[0-9]{2})(?![0-9])")
NUMERIC = re.compile(
    r"(?<![0-9.])(?P<day>[0-9]{1,2})\.(?P<month>[0-9]{1,2})(?:\.(?P<year>[0-9]{4}))?(?![0-9.])"
)
RUSSIAN = re.compile(
    r"(?<![0-9])(?P<day>[0-9]{1,2})\s+(?P<month>"
    + "|".join(MONTHS)
    + r")\b(?:\s+(?P<year>[0-9]{4})(?![0-9]))?",
    re.I,
)
CLOCK = re.compile(r"(?<![0-9:])(?P<hour>[0-9]{1,2}):(?P<minute>[0-9]{2})(?![0-9:])")
RELATIVE = re.compile(
    r"\b(?:сегодня|завтра|послезавтра|следующ\w*|через|понедельник\w*|вторник\w*|сред[ау]|четверг\w*|пятниц\w*|суббот\w*|воскресень\w*|выходн\w*)\b",
    re.I,
)
RANGE = re.compile(r"\b[0-9]{1,2}\s*[-–—]\s*[0-9]{1,2}\s+[а-я]", re.I)
SHORT_RANGE = re.compile(r"(?<![0-9])[0-9]{1,2}\s*[-–—]\s*[0-9]{1,2}(?=\.)")
YEAR_RANGE = re.compile(r"(?<![0-9])[0-9]{4}\s*[-–—]\s*[0-9]{4}(?![0-9])")
OLD_NEW_DAY = re.compile(r"\bс\s*[0-9]{1,2}\s+на\s*[0-9]{1,2}(?=\b|\.)", re.I)


def question(
    field: Literal["event_id", "year", "date", "time"],
    reason: Literal["missing", "ambiguous", "invalid", "past", "conflict"],
    candidate: str | None = None,
) -> Clarification:
    return Clarification(field=field, reason=reason, candidate_event_id=candidate)


@dataclass(frozen=True)
class Resolution:
    start: datetime | None
    partial: PartialDate
    year_source: YearSource | None
    clarifications: list[Clarification]
    event_revision: int | None = None


def _parse(prompt: str) -> tuple[dict[str, int | None], list[Clarification]]:
    parts: dict[str, int | None] = {
        name: None for name in ("year", "month", "day", "hour", "minute")
    }
    issues: list[Clarification] = []
    dates: list[dict[str, int | None]] = []
    clocks: list[tuple[int, int]] = []
    remaining = prompt
    for match in reversed(list(ISO.finditer(prompt))):
        try:
            parsed = datetime.fromisoformat(match.group()).astimezone(MOSCOW)
            parsed.astimezone(UTC)
            dates.append({"year": parsed.year, "month": parsed.month, "day": parsed.day})
            clocks.append((parsed.hour, parsed.minute))
        except ValueError, OverflowError:
            issues.append(question("date", "invalid"))
        remaining = (
            remaining[: match.start()]
            + " " * (match.end() - match.start())
            + remaining[match.end() :]
        )
    if re.search(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T", remaining):
        issues.append(question("time", "invalid"))
    for pattern in (ISO_DAY, NUMERIC, RUSSIAN):
        matches = list(pattern.finditer(remaining))
        for match in matches:
            fields = match.groupdict()
            month = MONTHS[fields["month"].lower()] if pattern is RUSSIAN else int(fields["month"])
            dates.append(
                {
                    "year": int(fields["year"]) if fields["year"] else None,
                    "month": month,
                    "day": int(fields["day"]),
                }
            )
            if fields["year"] is None and re.match(
                r"[\s,]+(?:год[ау]?\s*)?\d{2,}(?!\d|:)", remaining[match.end() :]
            ):
                issues.append(question("year", "invalid"))
        for match in reversed(matches):
            remaining = (
                remaining[: match.start()]
                + " " * (match.end() - match.start())
                + remaining[match.end() :]
            )
    clocks.extend((int(match["hour"]), int(match["minute"])) for match in CLOCK.finditer(remaining))
    if len(dates) == 1:
        parts.update(dates[0])
    elif len(dates) > 1:
        issues.append(question("date", "ambiguous"))
    if len(clocks) == 1:
        parts["hour"], parts["minute"] = clocks[0]
    elif len(clocks) > 1:
        issues.append(question("time", "ambiguous"))
    range_text = ISO_DAY.sub(" ", ISO.sub(" ", prompt))
    if RELATIVE.search(prompt) or any(
        pattern.search(range_text) for pattern in (RANGE, SHORT_RANGE, YEAR_RANGE, OLD_NEW_DAY)
    ):
        issues.append(question("date", "ambiguous"))
    if dates and re.search(r"\b(?:или|либо|между)\b", prompt, re.I):
        issues.append(question("date", "ambiguous"))
    named_zone = re.search(r"[0-9]{1,2}:[0-9]{2}\s+(?:по|в)\s+([а-яё]+)", prompt, re.I)
    if named_zone and named_zone[1].lower() not in {"московскому", "москве", "мск", "московском"}:
        issues.append(question("time", "conflict"))
    if re.search(r"\b(?:UTC|GMT|CET|CEST|EET|EEST|PST|PDT|EST|EDT)\b", remaining, re.I):
        issues.append(question("time", "conflict"))
    if re.search(r"\b[0-9]{1,2}\.[0-9]{1,2}\.[0-9]{1,3}\b", prompt):
        issues.append(question("date", "invalid"))
    return parts, issues


def resolve_date(state: AssistantState, event: OrganizerEvent | None, now: datetime) -> Resolution:
    parts, issues = _parse(state.original_prompt)
    source: YearSource | None = "explicit" if parts["year"] is not None else None
    answers = state.answers
    if answers.date is not None:
        chosen = datetime.fromisoformat(answers.date)
        parts.update(year=chosen.year, month=chosen.month, day=chosen.day)
        source = "clarification"
        issues = [issue for issue in issues if issue.field not in {"date", "year"}]
    if answers.year is not None:
        parts["year"] = answers.year
        source = "clarification"
        issues = [issue for issue in issues if issue.field != "year"]
    if answers.time is not None:
        parts["hour"], parts["minute"] = map(int, answers.time.split(":"))
        issues = [issue for issue in issues if issue.field != "time"]
    for field, names in (("date", ("year", "month", "day")), ("time", ("hour", "minute"))):
        if field not in state.manual_fields:
            continue
        answered = answers.date is not None if field == "date" else answers.time is not None
        if answered:
            continue
        for name in names:
            manual = getattr(state.partial_date, name)
            if name == "year" and answers.year is not None:
                continue
            if parts[name] is not None and manual is not None and parts[name] != manual:
                issues.append(question("date" if field == "date" else "time", "conflict"))
            parts[name] = manual
        if field == "date" and answers.year is None:
            source = "manual" if parts["year"] is not None else None
    if (
        source is None
        and state.year_source == "current_year"
        and state.partial_date.year is not None
    ):
        parts["year"] = state.partial_date.year
        source = "current_year"
        # A retry keeps its saved year, but a newly selected/changed event must
        # still support that default. Compare with the saved year so rollover
        # remains a past-year question rather than silently choosing a new year.
        if event is not None and event.starts_at.astimezone(MOSCOW).year != parts["year"]:
            issues.append(question("year", "conflict"))
    if (parts["month"] is None or parts["day"] is None) and not any(
        issue.field == "date" for issue in issues
    ):
        issues.append(question("date", "missing"))
    if (parts["hour"] is None or parts["minute"] is None) and not any(
        issue.field == "time" for issue in issues
    ):
        issues.append(question("time", "missing"))
    current = now.astimezone(MOSCOW)
    ambiguous = any(item.reason != "missing" for item in issues)
    if (
        not ambiguous
        and parts["year"] is None
        and parts["month"] is not None
        and parts["day"] is not None
    ):
        if event is not None and event.starts_at.astimezone(MOSCOW).year != current.year:
            issues.append(question("year", "conflict"))
        elif (
            event is not None
            and parts["hour"] is not None
            and parts["minute"] is not None
            and 0 <= parts["hour"] <= 23
            and 0 <= parts["minute"] <= 59
        ):
            parts["year"] = current.year
            source = "current_year"
    # Invalid components never enter the validated persisted partial state.
    try:
        partial = PartialDate.model_validate(parts)
    except ValidationError:
        bad_time = (
            parts["hour"] is not None
            and not 0 <= parts["hour"] <= 23
            or parts["minute"] is not None
            and not 0 <= parts["minute"] <= 59
        )
        leap_partial = None
        if not bad_time and source == "current_year":
            with suppress(ValidationError):
                leap_partial = PartialDate.model_validate({**parts, "year": None})
        if leap_partial is not None:
            parts["year"] = None
            source = None
            issues.append(question("year", "invalid"))
        else:
            issues.append(question("time" if bad_time else "date", "invalid"))
            for name in ("hour", "minute") if bad_time else ("year", "month", "day"):
                parts[name] = None
        try:
            partial = PartialDate.model_validate(parts)
        except ValidationError:
            partial = partial_from_start(None)
    start = None
    if all(value is not None for value in parts.values()):
        try:
            start = datetime(
                **{name: value for name, value in parts.items() if value is not None}, tzinfo=MOSCOW
            )
            exact = list(ISO.finditer(state.original_prompt))
            if (
                len(exact) == 1
                and source == "explicit"
                and not (answers.date or answers.time or answers.year)
                and not (set(state.manual_fields) & {"date", "time"})
            ):
                start = datetime.fromisoformat(exact[0].group()).astimezone(MOSCOW)
            start.astimezone(UTC)
            if start <= now:
                issues.append(question("year" if source == "current_year" else "date", "past"))
            elif event is not None and start == event.starts_at:
                issues.append(question("date", "conflict"))
        except ValueError, OverflowError:
            issues.append(question("date", "invalid"))
    unique = list(
        {(item.field, item.reason, item.candidate_event_id): item for item in issues}.values()
    )
    # At most one actionable reason per control; parser errors precede missingness.
    unique = list({item.field: item for item in reversed(unique)}.values())
    if (
        source == "current_year"
        and any(item.field == "year" for item in unique)
        and state.year_source != "current_year"
    ):
        partial = partial.model_copy(update={"year": None})
        source = None
    if partial.year is None:
        source = None
    return Resolution(
        None if unique else start, partial, source, unique, event.revision if event else None
    )
