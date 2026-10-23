import pytest
from fastapi.testclient import TestClient


def order(*ages: int) -> dict[str, object]:
    return {
        "participants": [
            {"name": f"Участник {index + 1}", "age": age} for index, age in enumerate(ages)
        ],
        "email": "guest@example.com",
    }


def test_event_describes_the_same_prices_and_limits_used_by_orders(client: TestClient) -> None:
    response = client.get("/api/event")
    assert response.status_code == 200
    event = response.json()
    assert event["id"]
    assert event["title"]
    assert {key: value for key, value in event.items() if key not in {"id", "title"}} == {
        "currency": "RUB",
        "max_participants": 4,
        "child_age_limit": 14,
        "companion_min_age": 18,
        "full_ticket_price": 2000,
        "child_ticket_price": 1000,
    }


@pytest.mark.parametrize(
    ("ages", "expected_prices", "expected_types"),
    [
        ([17], [2000], ["full"]),
        ([14], [2000], ["full"]),
        ([18, 13], [2000, 1000], ["full", "child"]),
        ([18, 13, 12], [2000, 1000, 1000], ["full", "child", "child"]),
        ([18, 13, 12, 0], [2000, 1000, 1000, 1000], ["full", "child", "child", "child"]),
        ([0, 18], [1000, 2000], ["child", "full"]),
        ([18, 18, 18, 18], [2000] * 4, ["full"] * 4),
    ],
)
def test_prices_and_age_boundaries(
    client: TestClient,
    order_path: str,
    ages: list[int],
    expected_prices: list[int],
    expected_types: list[str],
) -> None:
    response = client.post(order_path, json=order(*ages))
    assert response.status_code in {200, 201}
    result = response.json()
    assert result["total"] == sum(expected_prices)
    assert result["currency"] == "RUB"
    assert result["email"] == "guest@example.com"
    assert [participant["age"] for participant in result["participants"]] == ages
    assert [participant["price"] for participant in result["participants"]] == expected_prices
    assert [participant["ticket_type"] for participant in result["participants"]] == expected_types


def test_names_are_trimmed_and_email_domain_is_normalized(
    client: TestClient, order_path: str
) -> None:
    response = client.post(
        order_path,
        json={"participants": [{"name": "  Алиса  ", "age": 18}], "email": "Guest@EXAMPLE.COM"},
    )
    assert response.status_code in {200, 201}
    assert response.json()["participants"][0]["name"] == "Алиса"
    assert response.json()["email"] == "Guest@example.com"


@pytest.mark.parametrize("count", [0, 5])
def test_group_size_outside_one_to_four_is_rejected(
    client: TestClient, order_path: str, count: int
) -> None:
    response = client.post(order_path, json=order(*([18] * count)))
    assert response.status_code == 422
    assert any(error["loc"] == ["body", "participants"] for error in response.json()["detail"])


@pytest.mark.parametrize("ages", [[13], [13, 17], [0, 17], [0, 13], [17, 13, 12]])
def test_children_require_an_adult_in_the_same_order(
    client: TestClient, order_path: str, ages: list[int]
) -> None:
    response = client.post(order_path, json=order(*ages))
    assert response.status_code == 422
    errors = response.json()["detail"]
    assert any("сопровождающий от 18 лет" in error["msg"] for error in errors)
    assert [error["loc"] for error in errors] == [["body", "participants"]]


@pytest.mark.parametrize("age", [None, True, False, -1, 0.0, 13.5, "13", "", {}, []])
def test_invalid_age_types_or_negative_age_are_rejected_without_coercion(
    client: TestClient, order_path: str, age: object
) -> None:
    response = client.post(
        order_path,
        json={"participants": [{"name": "Гость", "age": age}], "email": "guest@example.com"},
    )
    assert response.status_code == 422
    assert any(
        error["loc"] == ["body", "participants", 0, "age"] for error in response.json()["detail"]
    )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"email": "guest@example.com"},
        {"participants": [{"name": "Гость", "age": 18}]},
        {"participants": [{"age": 18}], "email": "guest@example.com"},
        {"participants": [{"name": "Гость"}], "email": "guest@example.com"},
        {"participants": [{"name": "   ", "age": 18}], "email": "guest@example.com"},
        {"participants": [{"name": None, "age": 18}], "email": "guest@example.com"},
        {"participants": [{"name": True, "age": 18}], "email": "guest@example.com"},
        {"participants": [{"name": "Гость", "age": 18}], "email": "invalid"},
        {"participants": [{"name": "Гость", "age": 18}], "email": None},
        {"participants": [{"name": "Гость", "age": 18}], "email": True},
        {"participants": ["Гость"], "email": "guest@example.com"},
    ],
)
def test_missing_or_invalid_fields_are_rejected(
    client: TestClient, order_path: str, payload: dict[str, object]
) -> None:
    response = client.post(order_path, json=payload)
    assert response.status_code == 422
    assert response.json()["detail"]


@pytest.mark.parametrize(
    "payload",
    [
        {**order(18), "total": 1},
        {**order(18), "price": 1},
        {**order(18), "currency": "USD"},
        {
            "participants": [{"name": "Гость", "age": 18, "price": 1}],
            "email": "guest@example.com",
        },
        {
            "participants": [{"name": "Гость", "age": 18, "ticket_type": "child"}],
            "email": "guest@example.com",
        },
    ],
)
def test_client_cannot_submit_prices_or_other_unknown_fields(
    client: TestClient, order_path: str, payload: dict[str, object]
) -> None:
    response = client.post(order_path, json=payload)
    assert response.status_code == 422
    assert any(error["type"] == "extra_forbidden" for error in response.json()["detail"])


def test_validation_errors_have_public_shape_without_echoed_input(
    client: TestClient, order_path: str
) -> None:
    response = client.post(
        order_path,
        json={
            "participants": [{"name": "SECRET_NAME", "age": "SECRET_AGE"}],
            "email": "SECRET_EMAIL",
        },
    )
    assert response.status_code == 422
    errors = response.json()["detail"]
    assert errors
    assert all(set(error) == {"loc", "msg", "type"} for error in errors)
    assert "SECRET_" not in response.text
