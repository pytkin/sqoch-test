import smtplib
from collections.abc import Buffer
from concurrent.futures import ThreadPoolExecutor
from email import policy
from email.parser import BytesParser
from pathlib import Path

from delivery_helpers import NOW, confirmed_campaign

from sqoch_api.notifications.delivery import claim_next, recover_sending
from sqoch_api.notifications.store import connect_db


def test_claim_commits_attempt_before_network_and_never_claims_sending_again(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state.sqlite3"
    campaign_id = confirmed_campaign(path)
    job = claim_next(path, NOW)
    assert job is not None
    assert job.campaign_id == str(campaign_id)
    assert job.attempts == 1
    with connect_db(path) as connection:
        row = connection.execute("SELECT * FROM deliveries WHERE id=?", (job.id,)).fetchone()
        assert row["state"] == "sending"
        assert row["attempts"] == 1
        connection.execute("UPDATE deliveries SET state='sent' WHERE id!=?", (job.id,))
    assert claim_next(path, NOW) is None


def test_two_connections_claim_one_remaining_job_once(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent' WHERE email!='a@example.com'")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: claim_next(path, NOW), range(2)))
    assert sum(job is not None for job in results) == 1
    with connect_db(path) as connection:
        assert (
            connection.execute(
                "SELECT attempts FROM deliveries WHERE email='a@example.com'"
            ).fetchone()[0]
            == 1
        )


def test_recovery_preserves_attempts_and_does_not_retry_unknown_or_final_states(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    with connect_db(path) as connection:
        connection.execute("UPDATE deliveries SET state='sent'")
        connection.execute(
            "UPDATE deliveries SET state='sending',attempts=5 WHERE email='a@example.com'"
        )
    assert recover_sending(path) == 1
    assert recover_sending(path) == 0
    assert claim_next(path, NOW) is None
    with connect_db(path) as connection:
        row = connection.execute(
            "SELECT state,attempts FROM deliveries WHERE email='a@example.com'"
        ).fetchone()
        assert tuple(row) == ("unknown", 5)


def test_frozen_mime_uses_smtp_crlf_before_it_is_handed_to_transport(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    job = claim_next(path, NOW)
    assert job is not None
    assert b"\r\n" in job.mime
    assert b"\n" not in job.mime.replace(b"\r\n", b"")


def test_real_smtplib_data_framing_does_not_append_a_body_newline(tmp_path: Path) -> None:
    path = tmp_path / "state.sqlite3"
    confirmed_campaign(path)
    job = claim_next(path, NOW)
    assert job is not None

    class DataWire(smtplib.SMTP):
        def __init__(self) -> None:
            self.written: list[bytes] = []
            self.replies = iter([(354, b"Proceed"), (250, b"Stored")])

        def putcmd(self, cmd: str, args: str = "") -> None:
            assert cmd == "data"

        def getreply(self) -> tuple[int, bytes]:
            return next(self.replies)

        def send(self, s: Buffer | str) -> None:
            assert isinstance(s, bytes)
            self.written.append(s)

    wire = DataWire()
    assert wire.data(job.mime)[0] == 250
    assert wire.written[0].endswith(b"\r\n.\r\n")
    received = wire.written[0][:-3]
    frozen_body = BytesParser(policy=policy.default).parsebytes(job.mime).get_content()
    received_body = BytesParser(policy=policy.default).parsebytes(received).get_content()
    assert frozen_body.replace("\r\n", "\n") == received_body.replace("\r\n", "\n")
