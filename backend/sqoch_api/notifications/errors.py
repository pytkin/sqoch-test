"""Organizer failures and the shared optimistic draft guard."""

from sqoch_api.notifications.schemas import OrganizerErrorDetail
from sqoch_api.orders import ValidationIssue


class OrganizerError(Exception):
    def __init__(
        self, status: int, code: str, message: str, related_campaign_id: str | None = None
    ) -> None:
        self.status = status
        self.detail = OrganizerErrorDetail(
            code=code, message=message, related_campaign_id=related_campaign_id
        )
        super().__init__(code)


class DraftValidationError(Exception):
    def __init__(self, issues: list[ValidationIssue]) -> None:
        self.issues = issues
        super().__init__("missing_draft_value")


def require_draft_revision(
    phase: str,
    revision: int,
    expected_revision: int,
    *,
    immutable_message: str = "Подтверждённую рассылку нельзя изменить",
) -> None:
    """Check the saved version again inside the caller's write transaction."""
    if phase != "draft":
        raise OrganizerError(409, "campaign_immutable", immutable_message)
    if revision != expected_revision:
        raise OrganizerError(
            409, "revision_conflict", "Черновик изменился. Загрузите актуальную версию"
        )
