"""OS-held locks for the single-host SQLite demo."""

import fcntl
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class DatabaseBusyError(RuntimeError):
    """A live process owns a conflicting database lock."""


@contextmanager
def maintenance_lock(path: Path, *, exclusive: bool = False) -> Iterator[None]:
    with _file_lock(path, "maintenance", exclusive=exclusive):
        yield


@contextmanager
def worker_lock(path: Path) -> Iterator[None]:
    with _file_lock(path, "worker", exclusive=True):
        yield


@contextmanager
def _file_lock(path: Path, name: str, *, exclusive: bool) -> Iterator[None]:
    canonical = path.resolve()
    canonical.parent.mkdir(parents=True, exist_ok=True)
    lock_path = canonical.with_suffix(canonical.suffix + f".{name}.lock")
    with lock_path.open("a+b") as handle:
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(handle.fileno(), operation | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise DatabaseBusyError(f"Database {name} lock is already in use") from error
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
