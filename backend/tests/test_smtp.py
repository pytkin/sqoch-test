"""SMTP phase classification is independent of retry scheduling and storage."""

import smtplib
from dataclasses import dataclass, field
from io import BytesIO

import pytest

from sqoch_api.notifications.smtp import SMTPConnection, SMTPFactory, send_delivery

MIME = b"From: organizer@example.com\r\nTo: a@example.com\r\n\r\nFrozen content\r\n"


@dataclass
class FakeSMTP:
    replies: dict[str, int] = field(default_factory=dict)
    fail_at: str | None = None
    error: Exception | None = None
    calls: list[tuple[str, object]] = field(default_factory=list)

    def _reply(self, phase: str, value: object = None) -> tuple[int, bytes]:
        self.calls.append((phase, value))
        if self.fail_at == phase:
            assert self.error is not None
            raise self.error
        return self.replies.get(phase, 250), b"PRIVATE_SERVER_DETAIL a@example.com"

    def ehlo(self) -> tuple[int, bytes]:
        return self._reply("ehlo")

    def mail(self, sender: str) -> tuple[int, bytes]:
        return self._reply("mail", sender)

    def rcpt(self, recipient: str) -> tuple[int, bytes]:
        return self._reply("rcpt", recipient)

    def data(self, message: bytes) -> tuple[int, bytes]:
        return self._reply("data", message)

    def quit(self) -> tuple[int, bytes]:
        return self._reply("quit")

    def close(self) -> None:
        self.calls.append(("close", None))


def factory(fake: FakeSMTP) -> SMTPFactory:
    def connect(host: str, port: int, *, timeout: float) -> SMTPConnection:
        fake.calls.append(("connect", (host, port, timeout)))
        if fake.fail_at == "connect":
            assert fake.error is not None
            raise fake.error
        return fake

    return connect


def test_sends_one_frozen_message_to_one_envelope_recipient() -> None:
    fake = FakeSMTP()
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == "sent"
    assert result.code is None and result.message is None
    assert fake.calls == [
        ("connect", ("127.0.0.1", 1025, 10.0)),
        ("ehlo", None),
        ("mail", "organizer@example.com"),
        ("rcpt", "a@example.com"),
        ("data", MIME),
        ("quit", None),
        ("close", None),
    ]


@pytest.mark.parametrize("phase", ["ehlo", "mail", "rcpt", "data"])
@pytest.mark.parametrize("reply,expected", [(451, "retry_wait"), (550, "failed")])
def test_explicit_smtp_refusal_is_definitive_and_sanitized(
    phase: str, reply: int, expected: str
) -> None:
    fake = FakeSMTP(replies={phase: reply})
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == expected
    assert "PRIVATE" not in repr(result)
    assert "a@example.com" not in repr(result)
    phases = [call[0] for call in fake.calls]
    if phase != "data":
        assert "data" not in phases
    assert phases[-1] == "close"


@pytest.mark.parametrize("phase", ["connect", "ehlo", "mail", "rcpt"])
@pytest.mark.parametrize("error", [OSError("PRIVATE_CONNECTION"), TimeoutError("PRIVATE_TIMEOUT")])
def test_network_error_before_data_can_be_retried(phase: str, error: Exception) -> None:
    fake = FakeSMTP(fail_at=phase, error=error)
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == "retry_wait"
    assert result.code == "smtp_connection_error"
    assert "PRIVATE" not in repr(result)
    assert "data" not in [call[0] for call in fake.calls]


@pytest.mark.parametrize(
    "error", [OSError("PRIVATE_BROKEN_PIPE"), smtplib.SMTPServerDisconnected("PRIVATE_LOST_REPLY")]
)
def test_lost_data_result_is_unknown_and_cannot_be_retried_blindly(error: Exception) -> None:
    fake = FakeSMTP(fail_at="data", error=error)
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == "unknown"
    assert result.code == "smtp_outcome_unknown"
    assert "PRIVATE" not in repr(result)
    assert fake.calls[-1] == ("close", None)


@pytest.mark.parametrize("reply,expected", [(451, "retry_wait"), (550, "failed")])
def test_smtp_data_error_is_a_proven_refusal(reply: int, expected: str) -> None:
    fake = FakeSMTP(fail_at="data", error=smtplib.SMTPDataError(reply, b"PRIVATE_DATA_ERROR"))
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == expected
    assert "PRIVATE" not in repr(result)


@pytest.mark.parametrize("reply", [451, 500])
def test_generic_response_parser_error_after_data_is_not_a_proven_server_refusal(
    reply: int,
) -> None:
    fake = FakeSMTP(fail_at="data", error=smtplib.SMTPResponseException(reply, b"Line too long."))
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == "unknown"
    assert result.code == "smtp_outcome_unknown"


def test_actual_getreply_parser_failure_after_data_remains_unknown() -> None:
    class ParserFailure(FakeSMTP):
        def data(self, message: bytes) -> tuple[int, bytes]:
            self.calls.append(("data", message))
            parser = smtplib.SMTP()
            parser.file = BytesIO(b"500 " + b"X" * 9000 + b"\r\n")
            try:
                return parser.getreply()
            finally:
                parser.close()

    fake = ParserFailure()
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == "unknown"
    assert result.code == "smtp_outcome_unknown"


def test_final_data_success_survives_quit_error() -> None:
    fake = FakeSMTP(fail_at="quit", error=smtplib.SMTPServerDisconnected("PRIVATE_QUIT"))
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == "sent"
    assert result.code is None
    assert fake.calls[-1] == ("close", None)


def test_unexpected_data_reply_is_unknown_instead_of_false_success() -> None:
    fake = FakeSMTP(replies={"data": 354})
    result = send_delivery("127.0.0.1", 1025, "a@example.com", MIME, smtp_factory=factory(fake))
    assert result.state == "unknown"


def test_external_host_is_rejected_before_any_connection() -> None:
    fake = FakeSMTP()
    with pytest.raises(ValueError, match="loopback"):
        send_delivery("mail.example.com", 25, "a@example.com", MIME, smtp_factory=factory(fake))
    assert fake.calls == []
