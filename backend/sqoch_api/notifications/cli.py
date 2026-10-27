"""Explicit local database operations, never run implicitly to reload demo data."""

import argparse
import sqlite3
from pathlib import Path

from pydantic import ValidationError

from sqoch_api.notifications.config import load_config
from sqoch_api.notifications.fixtures import DEFAULT_FIXTURE
from sqoch_api.notifications.locks import DatabaseBusyError
from sqoch_api.notifications.store import MigrationError, init_db, load_demo, reset_db


def main() -> None:
    parser = argparse.ArgumentParser(description="Local Sqoch notification database")
    parser.add_argument("operation", choices=["db:init", "demo:load", "demo:reset"])
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--yes", action="store_true", help="Confirm deletion of saved campaigns")
    arguments = parser.parse_args()
    if arguments.operation == "demo:reset" and not arguments.yes:
        parser.error("demo:reset deletes saved campaigns; stop API/worker and pass --yes")
    path = load_config().database_path
    try:
        if arguments.operation == "db:init":
            init_db(path)
        elif arguments.operation == "demo:load":
            init_db(path)
            load_demo(path, arguments.fixture)
        else:
            reset_db(path, arguments.fixture, confirmed=arguments.yes)
    except (DatabaseBusyError, MigrationError, ValueError, OSError, sqlite3.Error) as error:
        # Do not print validation inputs or arbitrary SQL/fixture content.
        if isinstance(error, ValidationError):
            parser.exit(1, "Invalid demo fixture; database was not reset or loaded\n")
        parser.exit(1, f"Database operation failed ({type(error).__name__})\n")
    print(f"{arguments.operation}: complete")


if __name__ == "__main__":
    main()
