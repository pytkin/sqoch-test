"""Single-host worker executable, independent of any browser page."""

import argparse
import signal
import sqlite3
import time
from collections.abc import Callable
from uuid import UUID

from sqoch_api.notifications import service
from sqoch_api.notifications.config import ConfigurationError, NotificationConfig, load_config
from sqoch_api.notifications.delivery import (
    DeliveryJob,
    process_one,
    reconcile_campaign,
    recover_sending,
)
from sqoch_api.notifications.locks import DatabaseBusyError, maintenance_lock, worker_lock
from sqoch_api.notifications.mailpit import MailpitClient, MatchResult
from sqoch_api.notifications.smtp import SendResult, send_delivery
from sqoch_api.notifications.store import MigrationError, connect_db, init_db


def run_worker(
    config: NotificationConfig,
    *,
    once: bool = False,
    should_stop: Callable[[], bool] = lambda: False,
    sender: Callable[[DeliveryJob], SendResult] | None = None,
    checker: Callable[[DeliveryJob], MatchResult] | None = None,
    clock: service.Clock = service.utc_now,
    ready: Callable[[], None] | None = None,
) -> None:
    path = config.database_path
    init_db(path)
    with maintenance_lock(path), worker_lock(path):
        recover_sending(path)
        check = checker or MailpitClient(config.mailpit_url).check
        with connect_db(path) as connection:
            campaigns = [
                UUID(row[0])
                for row in connection.execute(
                    "SELECT DISTINCT campaign_id FROM deliveries WHERE state='unknown'"
                )
            ]
        for campaign_id in campaigns:
            if should_stop():
                return
            reconcile_campaign(path, campaign_id, check, clock)
        if ready:
            ready()

        def send(job: DeliveryJob) -> SendResult:
            return send_delivery(config.smtp_host, config.smtp_port, job.email, job.mime)

        while not should_stop():
            processed = process_one(path, sender or send, clock)
            if once:
                break
            if not processed:
                time.sleep(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Sqoch notification worker")
    parser.add_argument("--once", action="store_true", help="Process at most one eligible delivery")
    args = parser.parse_args()
    stopped = [False]

    def stop(_signal: int, _frame: object) -> None:
        stopped[0] = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        run_worker(
            load_config(),
            once=args.once,
            should_stop=lambda: stopped[0],
            ready=lambda: print("worker: ready", flush=True),
        )
    except sqlite3.Error, MigrationError, DatabaseBusyError, ConfigurationError:
        parser.exit(1, "Worker stopped: check local configuration, database and process locks\n")


if __name__ == "__main__":
    main()
