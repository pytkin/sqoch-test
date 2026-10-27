"""SQLite ownership for the local organizer demo."""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqoch_api.notifications.fixtures import DemoFixture, read_fixture, utc_text
from sqoch_api.notifications.locks import maintenance_lock

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"
_VERSION_ONE_COLUMNS = {
    "events": {"id", "title", "starts_at_utc", "timezone", "revision"},
    "purchases": {"id", "event_id", "email", "normalized_email", "status"},
    "campaigns": {
        "id",
        "phase",
        "revision",
        "created_at",
        "updated_at",
        "event_id",
        "proposed_start",
        "suggested_start",
        "subject",
        "body",
        "text_reviewed",
        "reviewed_event_revision",
        "prompt",
        "preview_json",
        "event_snapshot_json",
        "accepted_token",
        "confirmed_at",
    },
    "deliveries": {
        "id",
        "campaign_id",
        "email",
        "state",
        "attempts",
        "next_attempt_at",
        "message_id",
        "mime",
        "last_error_code",
        "last_error_message",
        "sent_at",
        "mailpit_message_id",
        "created_at",
    },
}


class MigrationError(RuntimeError):
    """The database schema cannot be safely initialized."""


@contextmanager
def connect_db(path: Path) -> Iterator[sqlite3.Connection]:
    canonical = path.resolve()
    canonical.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(canonical, timeout=5)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA busy_timeout=5000")
        with connection:
            yield connection
    finally:
        connection.close()


def init_db(path: Path, migrations_dir: Path | None = None) -> None:
    directory = migrations_dir or MIGRATIONS_DIR
    _, versions = _migration_files(directory)
    with maintenance_lock(path):
        current = _inspect_existing_database(path, versions)
        if current == max(versions):
            return
    # Never upgrade a shared lock in place: another API/worker may own it.
    with maintenance_lock(path, exclusive=True):
        _init_db(path, directory)


def _migration_files(migrations_dir: Path) -> tuple[list[Path], list[int]]:
    files = sorted(migrations_dir.glob("[0-9][0-9][0-9]_*.sql"))
    versions = [int(file.name.split("_", 1)[0]) for file in files]
    if not versions or len(versions) != len(set(versions)):
        raise MigrationError("Migration files are missing or have duplicate versions")
    return files, versions


def _schema_version(connection: sqlite3.Connection, versions: list[int]) -> int:
    applied = [row[0] for row in connection.execute("SELECT version FROM schema_migrations")]
    if any(type(version) is not int or version < 1 for version in applied):
        raise MigrationError("Database migration history contains an invalid version")
    current = max(applied, default=0)
    if current > max(versions) or sorted(applied) != list(range(1, current + 1)):
        raise MigrationError("Database schema is newer or has an unknown migration history")
    return int(current)


def _validate_known_schema(connection: sqlite3.Connection, version: int) -> None:
    if version < 1:
        return
    for table, required in _VERSION_ONE_COLUMNS.items():
        actual = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        if not required.issubset(actual):
            raise MigrationError(f"Known schema is incomplete: {table}")
    if version >= 2:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(campaigns)")}
        if "assistant_state_json" not in columns:
            raise MigrationError("Known schema is incomplete: campaigns")


def _inspect_existing_database(path: Path, versions: list[int]) -> int | None:
    canonical = path.resolve()
    if not canonical.is_file():
        return None
    # Inspect before journal_mode/DDL: a configured path may name another app's DB.
    connection = sqlite3.connect(canonical.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        objects = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
            )
        }
        if "schema_migrations" not in objects:
            if objects:
                raise MigrationError("Existing database is not a Sqoch database")
            return None
        current = _schema_version(connection, versions)
        if current == 0 and objects != {"schema_migrations"}:
            raise MigrationError("Database has objects without a known migration")
        _validate_known_schema(connection, current)
        return current
    except sqlite3.Error as error:
        raise MigrationError("Database schema cannot be read safely") from error
    finally:
        connection.close()


def _init_db(path: Path, migrations_dir: Path) -> None:
    files, versions = _migration_files(migrations_dir)
    _inspect_existing_database(path, versions)
    with connect_db(path) as connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)"
        )
        current = _schema_version(connection, versions)
    for version, file in zip(versions, files, strict=True):
        if version <= current:
            continue
        if version != current + 1:
            raise MigrationError("Migration sequence has a gap")
        try:
            with connect_db(path) as connection:
                connection.execute("BEGIN IMMEDIATE")
                _execute_migration(connection, file.read_text(encoding="utf8"))
                _validate_known_schema(connection, version)
                connection.execute("INSERT INTO schema_migrations(version) VALUES (?)", (version,))
        except (sqlite3.Error, OSError) as error:
            raise MigrationError(f"Migration {version} failed") from error
        current = version


def _execute_migration(connection: sqlite3.Connection, script: str) -> None:
    # executescript() commits an existing transaction; each statement must use execute().
    statement = ""
    for character in script:
        statement += character
        if character == ";" and sqlite3.complete_statement(statement):
            connection.execute(statement)
            statement = ""
    if statement.strip():
        connection.execute(statement)


def load_demo(path: Path, fixture_path: Path) -> None:
    fixture = read_fixture(fixture_path)
    with maintenance_lock(path):
        _load_fixture(path, fixture)


def _load_fixture(path: Path, fixture: DemoFixture) -> None:
    with connect_db(path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        for event in fixture.events:
            connection.execute(
                "INSERT INTO events(id,title,starts_at_utc,timezone) VALUES (?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET title=excluded.title, "
                "starts_at_utc=excluded.starts_at_utc, timezone=excluded.timezone, "
                "revision=events.revision+1 WHERE events.title IS NOT excluded.title "
                "OR events.starts_at_utc IS NOT excluded.starts_at_utc "
                "OR events.timezone IS NOT excluded.timezone",
                (event.id, event.title, utc_text(event.starts_at), event.timezone),
            )
        for purchase in fixture.purchases:
            connection.execute(
                "INSERT INTO purchases(id,event_id,email,normalized_email,status) "
                "VALUES (?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET event_id=excluded.event_id,email=excluded.email, "
                "normalized_email=excluded.normalized_email,status=excluded.status",
                (
                    purchase.id,
                    purchase.event_id,
                    str(purchase.email),
                    purchase.normalized_email,
                    purchase.status,
                ),
            )


def reset_db(path: Path, fixture_path: Path, *, confirmed: bool = False) -> None:
    if not confirmed:
        raise ValueError("Database reset requires explicit confirmation")
    fixture = read_fixture(fixture_path)
    canonical = path.resolve()
    with maintenance_lock(canonical, exclusive=True):
        for file in (canonical, Path(f"{canonical}-wal"), Path(f"{canonical}-shm")):
            file.unlink(missing_ok=True)
        _init_db(canonical, MIGRATIONS_DIR)
        _load_fixture(canonical, fixture)


def get_events(path: Path) -> list[dict[str, object]]:
    with connect_db(path) as connection:
        rows = connection.execute(
            "SELECT id,title,starts_at_utc AS starts_at,timezone,revision FROM events ORDER BY id"
        ).fetchall()
        return [dict(row) for row in rows]


def select_recipients(path: Path, event_id: str) -> list[str]:
    with connect_db(path) as connection:
        if connection.execute("SELECT 1 FROM events WHERE id=?", (event_id,)).fetchone() is None:
            raise LookupError("Unknown event")
        return recipient_emails(connection, event_id)


def recipient_emails(connection: sqlite3.Connection, event_id: str) -> list[str]:
    """Select from the caller's transaction so preview/confirm share its snapshot."""
    return [
        str(row[0])
        for row in connection.execute(
            "SELECT DISTINCT normalized_email FROM purchases "
            "WHERE event_id=? AND status='active' ORDER BY normalized_email",
            (event_id,),
        )
    ]
