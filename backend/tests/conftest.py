from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sqoch_api.app import create_app


@pytest.fixture(autouse=True)
def isolated_notification_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SQOCH_DATABASE_PATH", str(tmp_path / "notifications.sqlite3"))
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-flash")
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "notifications.sqlite3"


@pytest.fixture
def draft_client(database_path: Path) -> Iterator[TestClient]:
    with TestClient(
        create_app(
            frontend_dir=database_path.parent / "missing-dist", allowed_hosts=("testserver",)
        )
    ) as test_client:
        yield test_client


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture(params=["/api/orders/quote", "/api/orders"])
def order_path(request: pytest.FixtureRequest) -> str:
    assert isinstance(request.param, str)
    return request.param
