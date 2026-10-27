"""Explicit configuration for local notification integrations."""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import SecretStr


class ConfigurationError(ValueError):
    """A setting is invalid; its value is deliberately not exposed."""


@dataclass(frozen=True)
class NotificationConfig:
    database_path: Path
    smtp_host: str
    smtp_port: int
    mailpit_url: str
    deepseek_model: str
    deepseek_api_key: SecretStr | None = field(repr=False)


def load_config(environ: Mapping[str, str] | None = None) -> NotificationConfig:
    source = os.environ if environ is None else environ
    if source.get("LLM_PROVIDER", "deepseek") != "deepseek":
        raise ConfigurationError("Invalid LLM_PROVIDER: only deepseek is supported")
    raw_path = source.get("SQOCH_DATABASE_PATH", "data/sqoch.sqlite3")
    if not raw_path.strip() or any(ord(char) < 32 for char in raw_path):
        raise ConfigurationError("Invalid SQOCH_DATABASE_PATH")
    try:
        database_path = Path(raw_path).expanduser().resolve()
    except OSError, RuntimeError, ValueError:
        raise ConfigurationError("Invalid SQOCH_DATABASE_PATH") from None

    smtp_host = source.get("SQOCH_SMTP_HOST", "127.0.0.1")
    if smtp_host != "127.0.0.1":
        raise ConfigurationError("Invalid SQOCH_SMTP_HOST: use the literal loopback address")
    smtp_port = _port(source.get("SQOCH_SMTP_PORT", "1025"), "SQOCH_SMTP_PORT")

    mailpit_match = re.fullmatch(
        r"http://127\.0\.0\.1:([0-9]{1,5})/?",
        source.get("SQOCH_MAILPIT_URL", "http://127.0.0.1:8025"),
    )
    if mailpit_match is None:
        raise ConfigurationError("Invalid SQOCH_MAILPIT_URL: use the local HTTP base URL")
    mailpit_port = _port(mailpit_match.group(1), "SQOCH_MAILPIT_URL")

    model = source.get("DEEPSEEK_MODEL", "deepseek-flash")
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", model) is None:
        raise ConfigurationError("Invalid DEEPSEEK_MODEL")
    key = source.get("DEEPSEEK_API_KEY", "")
    if any(ord(char) < 32 for char in key):
        raise ConfigurationError("Invalid DEEPSEEK_API_KEY")

    return NotificationConfig(
        database_path=database_path,
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        mailpit_url=f"http://127.0.0.1:{mailpit_port}",
        deepseek_model=model,
        deepseek_api_key=SecretStr(key.strip()) if key.strip() else None,
    )


def _port(value: str, setting: str) -> int:
    if re.fullmatch(r"[0-9]{1,5}", value) is None or not 1 <= int(value) <= 65535:
        raise ConfigurationError(f"Invalid {setting}: expected a TCP port")
    return int(value)
