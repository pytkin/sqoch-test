"""Exercise the production worker with a deterministic, test-only SMTP boundary."""

import signal

from sqoch_api.notifications.config import load_config
from sqoch_api.notifications.mailpit import MatchResult
from sqoch_api.notifications.smtp import SendResult
from sqoch_api.notifications.worker import run_worker

stopped = False


def stop(_signal: int, _frame: object) -> None:
    global stopped
    stopped = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
run_worker(
    load_config(),
    sender=lambda _job: SendResult("sent"),
    checker=lambda _job: MatchResult("not_found_in_mailpit"),
    should_stop=lambda: stopped,
    ready=lambda: print("e2e worker: ready", flush=True),
)
