from uuid import UUID

from fastapi.testclient import TestClient


def payload(*ages: int) -> dict[str, object]:
    return {
        "participants": [{"name": f"Гость {index}", "age": age} for index, age in enumerate(ages)],
        "email": "guest@example.com",
    }


def test_confirm_recalculates_current_payload_without_requiring_a_quote(client: TestClient) -> None:
    response = client.post("/api/orders", json=payload(18, 13))
    assert response.status_code == 201
    result = response.json()
    assert result["total"] == 3000
    assert result["order_id"].startswith("sqoch-")
    assert UUID(result["order_id"].removeprefix("sqoch-"))


def test_edit_uses_current_server_price_and_removed_escort_is_rejected(client: TestClient) -> None:
    original = client.post("/api/orders/quote", json=payload(18, 13))
    assert original.status_code == 200
    assert original.json()["total"] == 3000

    edited = client.post("/api/orders", json=payload(18, 14))
    assert edited.status_code == 201
    assert edited.json()["total"] == 4000
    invalid = client.post("/api/orders", json=payload(13))
    assert invalid.status_code == 422


def test_sold_out_occurs_only_at_confirmation_and_is_distinct_from_validation(
    client: TestClient,
) -> None:
    headers = {"X-Demo-Scenario": "sold_out"}
    quote = client.post("/api/orders/quote", json=payload(18), headers=headers)
    assert quote.status_code == 200
    failed = client.post("/api/orders", json=payload(18), headers=headers)
    assert failed.status_code == 409
    assert failed.json()["detail"]["code"] == "sold_out"
    assert "мест" in failed.json()["detail"]["message"].lower()
    assert set(failed.json()["detail"]) == {"code", "message"}
    invalid = client.post("/api/orders", json=payload(13), headers=headers)
    assert invalid.status_code == 422


def test_scenarios_do_not_persist_stock_or_change_future_confirmations(client: TestClient) -> None:
    client.post("/api/orders", json=payload(18), headers={"X-Demo-Scenario": "sold_out"})
    first = client.post("/api/orders", json=payload(18))
    second = client.post("/api/orders", json=payload(18), headers={"X-Demo-Scenario": "success"})
    assert first.status_code == second.status_code == 201
    assert first.json()["order_id"] != second.json()["order_id"]


def test_invalid_scenario_is_a_public_validation_error(client: TestClient) -> None:
    response = client.post(
        "/api/orders", json=payload(18), headers={"X-Demo-Scenario": "anything_else"}
    )
    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["header", "X-Demo-Scenario"]
    assert set(response.json()["detail"][0]) == {"loc", "msg", "type"}
