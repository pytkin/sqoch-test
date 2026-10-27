"""Storage behavior is tested against real temporary SQLite files."""

import json
import multiprocessing
import sqlite3
from pathlib import Path

import pytest
from pydantic import ValidationError

from sqoch_api.notifications.locks import DatabaseBusyError, maintenance_lock, worker_lock
from sqoch_api.notifications.store import (
    MigrationError,
    connect_db,
    get_events,
    init_db,
    load_demo,
    reset_db,
)

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "demo.json"


def test_init_is_idempotent_and_connection_enforces_durable_settings(tmp_path: Path) -> None:
    path = tmp_path / "new" / "demo.sqlite3"
    init_db(path)
    init_db(path)
    with connect_db(path) as connection:
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("PRAGMA synchronous").fetchone()[0] == 2
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
        assert connection.execute("SELECT version FROM schema_migrations").fetchall()
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM purchases").fetchone()[0] == 0
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO purchases(id,event_id,email,normalized_email,status) "
                "VALUES ('orphan','missing','a@example.com','a@example.com','active')"
            )


def test_failed_migration_rolls_back_ddl_and_version(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "003_broken.sql").write_text(
        "CREATE TABLE must_rollback(id TEXT); INVALID SQL;", encoding="utf8"
    )
    with pytest.raises(MigrationError):
        init_db(path, migrations)
    with connect_db(path) as connection:
        assert not connection.execute(
            "SELECT name FROM sqlite_master WHERE name='must_rollback'"
        ).fetchall()
        assert connection.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == 2


def test_newer_schema_is_rejected_without_destroying_it(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    with connect_db(path) as connection:
        connection.execute("INSERT INTO schema_migrations(version) VALUES (999)")
    with pytest.raises(MigrationError):
        init_db(path)
    with connect_db(path) as connection:
        assert connection.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == 999


def test_foreign_database_is_rejected_without_creating_sqoch_schema(tmp_path: Path) -> None:
    path = tmp_path / "foreign.sqlite3"
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE foreign_records(id INTEGER PRIMARY KEY, value TEXT)")
    connection.execute("INSERT INTO foreign_records(value) VALUES ('Keep this data')")
    connection.commit()
    connection.close()
    original = path.read_bytes()
    with pytest.raises(MigrationError):
        init_db(path)
    assert path.read_bytes() == original
    connection = sqlite3.connect(path)
    try:
        assert connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall() == [("foreign_records",)]
    finally:
        connection.close()


@pytest.mark.parametrize(
    "corruption", ["missing_table", "missing_column", "missing_assistant_column"]
)
def test_known_version_with_incomplete_schema_is_rejected_without_repair(
    tmp_path: Path, corruption: str
) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    with connect_db(path) as connection:
        if corruption == "missing_table":
            connection.execute("DROP TABLE deliveries")
        elif corruption == "missing_column":
            connection.execute("ALTER TABLE campaigns DROP COLUMN accepted_token")
        else:
            connection.execute("ALTER TABLE campaigns DROP COLUMN assistant_state_json")
    original = path.read_bytes()
    with pytest.raises(MigrationError):
        init_db(path)
    assert path.read_bytes() == original
    with sqlite3.connect(path) as connection:
        assert connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall() == [(1,), (2,)]


def test_current_schema_can_be_checked_while_live_process_holds_shared_lock(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    with maintenance_lock(path):
        init_db(path)
    assert get_events(path) == []


def test_pending_migration_refuses_live_shared_lock_without_changes(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "003_pending.sql").write_text("CREATE TABLE not_yet(id TEXT);", encoding="utf8")
    with maintenance_lock(path), pytest.raises(DatabaseBusyError):
        init_db(path, migrations)
    with connect_db(path) as connection:
        assert connection.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == 2
        assert not connection.execute(
            "SELECT name FROM sqlite_master WHERE name='not_yet'"
        ).fetchall()


def test_fixture_upsert_keeps_existing_campaign_and_unlisted_purchase(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    with connect_db(path) as connection:
        connection.execute(
            "INSERT INTO campaigns(id,created_at,updated_at,subject) VALUES "
            "('saved','2026-10-26T12:00:00Z','2026-10-26T12:00:00Z','Keep me')"
        )
        connection.execute(
            "INSERT INTO purchases(id,event_id,email,normalized_email,status) "
            "VALUES ('extra','ceramics','extra@example.com','extra@example.com','active')"
        )
    load_demo(path, FIXTURE_PATH)
    with connect_db(path) as connection:
        assert connection.execute("SELECT count(*) FROM purchases").fetchone()[0] == 21
        assert connection.execute("SELECT subject FROM campaigns WHERE id='saved'").fetchone()[
            0
        ] == ("Keep me")
        assert (
            connection.execute("SELECT revision FROM events WHERE id='ceramics'").fetchone()[0] == 0
        )


def test_changed_fixture_event_increments_revision_once(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf8"))
    fixture["events"][0]["title"] = "Керамика: новая программа"
    edited = tmp_path / "edited.json"
    edited.write_text(json.dumps(fixture), encoding="utf8")
    load_demo(path, edited)
    load_demo(path, edited)
    events = get_events(path)
    assert events[0]["title"] == "Керамика: новая программа"
    assert events[0]["revision"] == 1


def test_sql_failure_mid_fixture_rolls_back_events_and_prior_purchases(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    original = get_events(path)
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf8"))
    fixture["events"][0]["title"] = "Must roll back"
    fixture["purchases"][0]["email"] = "changed@example.com"
    edited = tmp_path / "sql-failure.json"
    edited.write_text(json.dumps(fixture), encoding="utf8")
    with connect_db(path) as connection:
        connection.execute(
            "CREATE TRIGGER reject_last BEFORE INSERT ON purchases WHEN NEW.id='p20' "
            "BEGIN SELECT RAISE(ABORT, 'test failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="test failure"):
        load_demo(path, edited)
    assert get_events(path) == original
    with connect_db(path) as connection:
        assert connection.execute("SELECT email FROM purchases WHERE id='p01'").fetchone()[0] == (
            "a@example.com"
        )


def test_invalid_reset_fixture_is_validated_before_deleting_saved_data(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    with connect_db(path) as connection:
        connection.execute("UPDATE events SET title='Saved local edit' WHERE id='ceramics'")
    invalid = tmp_path / "invalid.json"
    invalid.write_text('{"events":[],"purchases":[{"id":"invalid"}]}', encoding="utf8")
    with pytest.raises(ValidationError):
        reset_db(path, invalid, confirmed=True)
    assert get_events(path)[0]["title"] == "Saved local edit"


@pytest.mark.parametrize("invalid", ["email", "unknown_event", "duplicate_id", "naive_date"])
def test_invalid_fixture_changes_nothing(tmp_path: Path, invalid: str) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    original = get_events(path)
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf8"))
    fixture["events"][0]["title"] = "Must not be persisted"
    if invalid == "email":
        fixture["purchases"][0]["email"] = "invalid"
    elif invalid == "unknown_event":
        fixture["purchases"][0]["event_id"] = "missing"
    elif invalid == "duplicate_id":
        fixture["purchases"][1]["id"] = fixture["purchases"][0]["id"]
    else:
        fixture["events"][0]["starts_at"] = "2026-11-20T19:00:00"
    edited = tmp_path / "invalid.json"
    edited.write_text(json.dumps(fixture), encoding="utf8")
    with pytest.raises(ValidationError):
        load_demo(path, edited)
    assert get_events(path) == original
    with connect_db(path) as connection:
        assert connection.execute("SELECT count(*) FROM purchases").fetchone()[0] == 20


def test_reset_requires_confirmation_and_preserves_lock_files(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    with pytest.raises(ValueError, match="confirmation"):
        reset_db(path, FIXTURE_PATH)
    reset_db(path, FIXTURE_PATH, confirmed=True)
    assert len(get_events(path)) == 2
    assert path.with_suffix(path.suffix + ".maintenance.lock").exists()


def _try_reset_while_live(path: str, fixture: str, result: multiprocessing.Queue[str]) -> None:
    try:
        reset_db(Path(path), Path(fixture), confirmed=True)
    except DatabaseBusyError:
        result.put("busy")
    else:
        result.put("reset")


def test_live_shared_lock_prevents_cross_process_reset(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    context = multiprocessing.get_context("spawn")
    queue: multiprocessing.Queue[str] = context.Queue()
    with maintenance_lock(path):
        with connect_db(path) as connection:
            connection.execute("UPDATE events SET title='Live data' WHERE id='ceramics'")
        child = context.Process(
            target=_try_reset_while_live, args=(str(path), str(FIXTURE_PATH), queue)
        )
        child.start()
        child.join(10)
        if child.is_alive():
            child.terminate()
            child.join(5)
            pytest.fail("reset child did not finish")
        assert child.exitcode == 0
        assert queue.get(timeout=2) == "busy"
    queue.close()
    assert get_events(path)[0]["title"] == "Live data"


def test_conflicting_worker_lock_is_rejected_and_release_allows_restart(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    with worker_lock(path), pytest.raises(DatabaseBusyError), worker_lock(path):
        pytest.fail("second worker acquired lock")
    with worker_lock(path):
        pass
