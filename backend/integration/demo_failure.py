"""Readable local SMTP failure demonstration using the acceptance scenario."""

from pathlib import Path
from tempfile import TemporaryDirectory

from test_delivery_acceptance import (
    test_real_sender_failure_continues_without_resending_successes,
)


def main() -> None:
    print("Локальная техническая демонстрация: временная SQLite, Mailpit 11025/18025", flush=True)
    with TemporaryDirectory(prefix="sqoch-smtp-demo-") as directory:
        test_real_sender_failure_continues_without_resending_successes(Path(directory))
    print(
        "Тестовые письма остаются в отдельном Mailpit volume; обычные данные не изменены",
        flush=True,
    )


if __name__ == "__main__":
    main()
