import multiprocessing
import os
import selectors
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from delivery_helpers import NOW, confirmed_campaign

from sqoch_api.notifications import delivery, service
from sqoch_api.notifications.config import load_config
from sqoch_api.notifications.delivery import DeliveryJob, claim_next
from sqoch_api.notifications.fixtures import DEFAULT_FIXTURE
from sqoch_api.notifications.locks import DatabaseBusyError, maintenance_lock, worker_lock
from sqoch_api.notifications.mailpit import MatchResult
from sqoch_api.notifications.smtp import SendResult
from sqoch_api.notifications.store import connect_db, reset_db
from sqoch_api.notifications.worker import run_worker


def test_worker_recovers_sending_and_once_readback_without_spending_attempt(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    claimed = claim_next(path, NOW)
    assert claimed is not None
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent' WHERE id!=?", (claimed.id,))
    checked: list[str] = []

    def checker(job: DeliveryJob) -> MatchResult:
        checked.append(job.id)
        return MatchResult("matched", "stored-mail")

    run_worker(
        load_config({"SQOCH_DATABASE_PATH": str(path)}),
        once=True,
        checker=checker,
        sender=lambda job: pytest.fail("Recovered success must not be sent"),
        clock=lambda: NOW,
    )
    assert checked == [claimed.id]
    assert service.get_campaign(path, campaign_id).status == "completed"
    with connect_db(path) as connection:
        assert (
            connection.execute(
                "SELECT attempts FROM deliveries WHERE id=?", (claimed.id,)
            ).fetchone()[0]
            == 1
        )


def test_result_storage_failure_stops_worker_before_another_smtp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    calls: list[str] = []

    def sender(job: DeliveryJob) -> SendResult:
        calls.append(job.id)
        return SendResult("sent")

    def broken_record(*args: object, **kwargs: object) -> None:
        raise sqlite3.OperationalError("Do not expose private storage detail")

    monkeypatch.setattr(delivery, "record_result", broken_record)
    with pytest.raises(sqlite3.OperationalError):
        run_worker(
            load_config({"SQOCH_DATABASE_PATH": str(path)}), sender=sender, clock=lambda: NOW
        )
    assert len(calls) == 1
    with connect_db(path) as connection:
        assert (
            connection.execute("SELECT count(*) FROM deliveries WHERE state='sending'").fetchone()[
                0
            ]
            == 1
        )


def _hold_worker(
    path: str, ready: multiprocessing.Queue[str], stop: multiprocessing.synchronize.Event
) -> None:
    run_worker(
        load_config({"SQOCH_DATABASE_PATH": path}),
        should_stop=stop.is_set,
        sender=lambda job: SendResult("unknown", "test_unknown", "Требует проверки"),
        checker=lambda job: MatchResult("not_found_in_mailpit"),
        ready=lambda: ready.put("ready"),
        clock=lambda: NOW,
    )


def test_live_worker_excludes_second_process_and_reset_and_releases_after_crash(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent'")
    context = multiprocessing.get_context("spawn")
    queue: multiprocessing.Queue[str] = context.Queue()
    stop = context.Event()
    child = context.Process(target=_hold_worker, args=(str(path), queue, stop))
    child.start()
    try:
        assert queue.get(timeout=10) == "ready"
        with pytest.raises(DatabaseBusyError), worker_lock(path):
            pytest.fail("Second worker acquired singleton lock")
        with pytest.raises(DatabaseBusyError):
            reset_db(path, DEFAULT_FIXTURE, confirmed=True)
        with maintenance_lock(path):
            assert service.get_campaign(path, campaign_id).status == "completed"
        child.kill()
        child.join(5)
        assert not child.is_alive()
        with worker_lock(path), maintenance_lock(path, exclusive=True):
            pass
    finally:
        stop.set()
        if child.is_alive():
            child.terminate()
        child.join(5)
        queue.close()


def test_cli_sigterm_is_graceful_and_releases_process_locks(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent'")
    child = subprocess.Popen(
        [sys.executable, "-m", "sqoch_api.notifications.worker"],
        env={**os.environ, "SQOCH_DATABASE_PATH": str(path)},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert child.stdout is not None
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            assert selector.select(timeout=10), "Worker did not become ready"
            assert child.stdout.readline().strip() == "worker: ready"
        child.terminate()
        assert child.wait(timeout=5) == 0
        with worker_lock(path), maintenance_lock(path, exclusive=True):
            pass
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=5)
