from fastapi.testclient import TestClient

from sqoch_api.app import create_app


def test_http_test_harness_can_load_openapi() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/openapi.json")
    assert response.status_code == 200
    assert response.json()["info"]["title"] == "Sqoch API"
