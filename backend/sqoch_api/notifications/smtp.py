"""One SMTP transaction, with explicit knowledge of acceptance uncertainty."""

import smtplib
from contextlib import suppress
from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class SendResult:
    state: Literal["sent", "retry_wait", "failed", "unknown"]
    code: str | None = None
    message: str | None = None


class SMTPConnection(Protocol):
    def ehlo(self) -> tuple[int, bytes]: ...
    def mail(self, sender: str) -> tuple[int, bytes]: ...
    def rcpt(self, recipient: str) -> tuple[int, bytes]: ...
    def data(self, message: bytes) -> tuple[int, bytes]: ...
    def quit(self) -> tuple[int, bytes]: ...
    def close(self) -> None: ...


class SMTPFactory(Protocol):
    def __call__(self, host: str, port: int, *, timeout: float) -> SMTPConnection: ...


def send_delivery(
    host: str,
    port: int,
    email: str,
    mime: bytes,
    *,
    smtp_factory: SMTPFactory | None = None,
) -> SendResult:
    if host != "127.0.0.1":
        raise ValueError("SMTP requires the literal loopback address")
    connect = smtp_factory or _connect
    connection: SMTPConnection | None = None
    phase = "connect"
    try:
        connection = connect(host, port, timeout=10.0)
        phase = "ehlo"
        code, _ = connection.ehlo()
        if code != 250:
            return _reply_result(code, data_started=False)
        phase = "mail"
        code, _ = connection.mail("organizer@example.com")
        if code != 250:
            return _reply_result(code, data_started=False)
        phase = "rcpt"
        code, _ = connection.rcpt(email)
        if code not in {250, 251}:
            return _reply_result(code, data_started=False)
        # From this point a missing reply cannot prove that Mailpit did not
        # accept the body. The immutable Message-ID is checked by reconciliation.
        phase = "data"
        code, _ = connection.data(mime)
        if code != 250:
            return _reply_result(code, data_started=True)
        # A final DATA 250 already proves acceptance; QUIT is cleanup only.
        with suppress(OSError):
            connection.quit()
        return SendResult("sent")
    except smtplib.SMTPDataError as error:
        return _reply_result(error.smtp_code, data_started=phase == "data")
    except smtplib.SMTPResponseException as error:
        # getreply() also raises this base exception for local parser failures
        # (for example an oversized response line), not only server refusals.
        if phase == "data":
            return _unknown()
        return _reply_result(error.smtp_code, data_started=False)
    except OSError:
        if phase == "data":
            return _unknown()
        return SendResult(
            "retry_wait", "smtp_connection_error", "Не удалось подключиться к службе отправки"
        )
    finally:
        if connection is not None:
            with suppress(OSError):
                connection.close()


def _connect(host: str, port: int, *, timeout: float) -> SMTPConnection:
    return smtplib.SMTP(host, port, timeout=timeout)


def _reply_result(code: int, *, data_started: bool) -> SendResult:
    if 400 <= code < 500:
        return SendResult(
            "retry_wait", "smtp_temporary_failure", "Служба отправки временно отклонила письмо"
        )
    if 500 <= code < 600:
        return SendResult(
            "failed", "smtp_permanent_failure", "Служба отправки окончательно отклонила письмо"
        )
    if data_started:
        return _unknown()
    return SendResult("failed", "smtp_protocol_error", "Неожиданный ответ службы отправки")


def _unknown() -> SendResult:
    return SendResult(
        "unknown", "smtp_outcome_unknown", "Результат отправки неизвестен. Требуется проверка"
    )
