import json
import os
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from sqoch_api.app import create_app


def test_api_works_when_frontend_has_not_been_built(tmp_path: Path) -> None:
    with TestClient(create_app(frontend_dir=tmp_path / "absent")) as client:
        assert client.get("/api/event").status_code == 200
        assert client.get("/").status_code == 404


def test_built_frontend_is_served_without_shadowing_api(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<main>Sqoch demo</main>", encoding="utf-8")
    (tmp_path / "app.js").write_text("console.log('demo');", encoding="utf-8")
    with TestClient(create_app(frontend_dir=tmp_path)) as client:
        assert client.get("/").text == "<main>Sqoch demo</main>"
        assert client.get("/app.js").status_code == 200
        assert client.get("/api/event").json()["currency"] == "RUB"
        assert client.get("/api/missing").status_code == 404
        assert client.get("/unknown-route").status_code == 404


def test_openapi_declares_real_request_success_and_error_contracts(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    assert schema["paths"]["/api/orders"]["post"]["responses"]["201"]
    assert schema["paths"]["/api/orders"]["post"]["responses"]["409"]
    validation = schema["components"]["schemas"]["ValidationIssue"]
    assert set(validation["properties"]) == {"loc", "msg", "type"}
    assert validation["additionalProperties"] is False
    request = schema["components"]["schemas"]["OrderRequest"]
    assert request["properties"]["participants"]["minItems"] == 1
    assert request["properties"]["participants"]["maxItems"] == 4
    assert request["additionalProperties"] is False


def test_response_schema_requires_fields_that_server_always_returns(client: TestClient) -> None:
    schemas = client.get("/openapi.json").json()["components"]["schemas"]
    for name in ("Event", "Quote", "ConfirmedOrder", "SoldOut", "SoldOutResponse"):
        assert set(schemas[name]["properties"]) == set(schemas[name].get("required", [])), name


def test_schema_export_is_deterministic_and_needs_no_running_server(tmp_path: Path) -> None:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run(
        [sys.executable, "-m", "sqoch_api.export_openapi"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == create_app().openapi()
