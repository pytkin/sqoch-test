from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from sqoch_api.app import create_app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture(params=["/api/orders/quote", "/api/orders"])
def order_path(request: pytest.FixtureRequest) -> str:
    assert isinstance(request.param, str)
    return request.param
