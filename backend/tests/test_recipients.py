from pathlib import Path

import pytest

from sqoch_api.notifications.store import connect_db, init_db, load_demo, select_recipients

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "demo.json"


def test_demo_has_twenty_purchases_and_expected_unique_active_recipients(tmp_path: Path) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    with connect_db(path) as connection:
        assert connection.execute("SELECT count(*) FROM events").fetchone()[0] == 2
        assert connection.execute("SELECT count(*) FROM purchases").fetchone()[0] == 20
        assert (
            connection.execute("SELECT count(*) FROM purchases WHERE status='active'").fetchone()[0]
            == 15
        )
    assert select_recipients(path, "ceramics") == [f"{letter}@example.com" for letter in "abcdefgh"]
    assert select_recipients(path, "painting") == [f"{letter}@example.com" for letter in "aklmn"]


def test_cancelled_only_event_has_no_recipients_but_unknown_event_is_an_error(
    tmp_path: Path,
) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    with connect_db(path) as connection:
        connection.execute("UPDATE purchases SET status='cancelled' WHERE event_id='ceramics'")
    assert select_recipients(path, "ceramics") == []
    with pytest.raises(LookupError):
        select_recipients(path, "missing")


def test_one_active_purchase_wins_over_cancelled_duplicates_without_cross_event_leak(
    tmp_path: Path,
) -> None:
    path = tmp_path / "demo.sqlite3"
    init_db(path)
    load_demo(path, FIXTURE_PATH)
    ceramics = select_recipients(path, "ceramics")
    assert ceramics.count("a@example.com") == 1
    assert "i@example.com" not in ceramics
    assert "k@example.com" not in ceramics
    with connect_db(path) as connection:
        row = connection.execute("SELECT normalized_email FROM purchases WHERE id='p09'").fetchone()
        assert row[0] == "a@example.com"
