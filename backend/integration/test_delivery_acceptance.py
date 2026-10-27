"""Real SMTP/process acceptance, opt-in through the isolated Mailpit runner."""

import socket
import time
from email import policy
from email.parser import BytesParser
from pathlib import Path

from mailpit_support import (
    BODY,
    confirmed_campaign,
    crash_after_smtp_acceptance,
    delete_own_message,
    deliveries,
    mailpit_api,
    message_count,
    raw_message,
    restart_mailpit,
    run_once,
    running_api,
)

from sqoch_api.notifications.delivery import claim_next
from sqoch_api.notifications.schemas import CampaignDetail
from sqoch_api.notifications.service import utc_now

EXPECTED_EMAILS = {f"{letter}@example.com" for letter in "abcdefgh"}


def test_real_sender_failure_continues_without_resending_successes(tmp_path: Path) -> None:
    with confirmed_campaign(tmp_path / "retry.sqlite3") as campaign, mailpit_api() as api:
        for _ in range(3):
            run_once(campaign.path)
        before = deliveries(campaign.path, campaign.id)
        sent_before = {item.id for item in before if item.state == "sent"}
        assert len(sent_before) == 3
        assert campaign.read().counters.sent == 3
        print("Отправлено 3 из 8: worker остановлен между заданиями", flush=True)
        api.put(
            "/api/v1/chaos", json={"Sender": {"ErrorCode": 451, "Probability": 100}}
        ).raise_for_status()
        run_once(campaign.path)
        refused = deliveries(campaign.path, campaign.id)
        failed_attempt = [item for item in refused if item.state == "retry_wait"]
        assert len(failed_attempt) == 1
        assert failed_attempt[0].attempts == 1
        assert failed_attempt[0].error_code == "smtp_temporary_failure"
        assert message_count(api, failed_attempt[0].message_id) == 0
        print("Включён Sender 451/100%: четвёртая попытка отклонена, письмо не принято", flush=True)
        # No worker is running. Even after its automatic retry deadline, no mail appears.
        time.sleep(6)
        assert campaign.read().counters.sent == 3
        assert sum(message_count(api, item.message_id) for item in refused) == 3
        print("Срок автоматического повтора прошёл: без worker всё ещё 3 письма", flush=True)
        api.put("/api/v1/chaos", json={}).raise_for_status()
        resumed = campaign.client.post(campaign.endpoint + "/resume", json={})
        assert resumed.status_code == 200
        print("Chaos выключен, выполнено ручное продолжение той же рассылки", flush=True)
        for _ in range(5):
            run_once(campaign.path)
        completed = campaign.read()
        assert completed.status == "completed"
        assert completed.counters.sent == completed.counters.total == 8
        final = deliveries(campaign.path, campaign.id)
        assert len(final) == len({item.email for item in final}) == 8
        assert {item.email for item in final} == EXPECTED_EMAILS
        assert all(item.state == "sent" for item in final)
        assert all(item.attempts == 1 for item in final if item.id in sent_before)
        assert next(item for item in final if item.id == failed_attempt[0].id).attempts == 2
        assert all(message_count(api, item.message_id) == 1 for item in final)
        for item in final:
            accepted = BytesParser(policy=policy.default).parsebytes(
                raw_message(api, item.message_id)
            )
            assert str(accepted["To"]) == item.email
        print(
            "Завершено: 8 из 8, по одному письму на адрес; прежние успехи не повторялись",
            flush=True,
        )


def test_crash_after_real_smtp_acceptance_recovers_one_message_without_duplicate(
    tmp_path: Path,
) -> None:
    with confirmed_campaign(tmp_path / "crash.sqlite3") as campaign, mailpit_api() as api:
        crash_after_smtp_acceptance(campaign.path)
        crashed = [
            item for item in deliveries(campaign.path, campaign.id) if item.state == "sending"
        ]
        assert len(crashed) == 1
        target = crashed[0]
        assert target.attempts == 1
        assert message_count(api, target.message_id) == 1
        assert b"\n" not in target.mime.replace(b"\r\n", b"")
        accepted = BytesParser(policy=policy.default).parsebytes(
            raw_message(api, target.message_id)
        )
        assert accepted.get_content().replace("\r\n", "\n") == BODY + "\n"
        # Startup performs readback, then --once may send the next pending recipient.
        run_once(campaign.path)
        recovered = next(
            item for item in deliveries(campaign.path, campaign.id) if item.id == target.id
        )
        assert recovered.state == "sent"
        assert recovered.attempts == 1
        assert recovered.mailpit_id is not None
        assert message_count(api, target.message_id) == 1
        for _ in range(6):
            run_once(campaign.path)
        assert campaign.read().status == "completed"
        assert all(
            message_count(api, item.message_id) == 1
            for item in deliveries(campaign.path, campaign.id)
        )


def test_missing_mail_and_unavailable_readback_never_retry_unknown(tmp_path: Path) -> None:
    with confirmed_campaign(tmp_path / "unknown.sqlite3") as campaign, mailpit_api() as api:
        target = claim_next(campaign.path, utc_now())
        assert target is not None
        # Represents a process death between its durable claim and any SMTP acceptance.
        run_once(campaign.path)
        unknown = next(
            item for item in deliveries(campaign.path, campaign.id) if item.id == target.id
        )
        assert unknown.state == "unknown"
        assert unknown.attempts == 1
        assert unknown.error_code == "not_found_in_mailpit"
        assert message_count(api, target.message_id) == 0
        with socket.socket() as unavailable:
            unavailable.bind(("127.0.0.1", 0))
            unused_port = unavailable.getsockname()[1]
            run_once(campaign.path, mailpit_url=f"http://127.0.0.1:{unused_port}")
        unknown = next(
            item for item in deliveries(campaign.path, campaign.id) if item.id == target.id
        )
        assert unknown.state == "unknown"
        assert unknown.attempts == 1
        assert unknown.error_code == "mailpit_unavailable"
        assert message_count(api, target.message_id) == 0


def test_deleted_accepted_message_is_not_treated_as_permission_to_send_again(
    tmp_path: Path,
) -> None:
    with confirmed_campaign(tmp_path / "deleted.sqlite3") as campaign, mailpit_api() as api:
        crash_after_smtp_acceptance(campaign.path)
        sending = [
            item for item in deliveries(campaign.path, campaign.id) if item.state == "sending"
        ]
        assert len(sending) == 1
        target = sending[0]
        assert message_count(api, target.message_id) == 1
        delete_own_message(api, target.message_id)
        assert message_count(api, target.message_id) == 0
        run_once(campaign.path)
        unknown = next(
            item for item in deliveries(campaign.path, campaign.id) if item.id == target.id
        )
        assert unknown.state == "unknown"
        assert unknown.attempts == 1
        assert unknown.error_code == "not_found_in_mailpit"
        assert campaign.client.post(campaign.endpoint + "/resume", json={}).status_code == 200
        run_once(campaign.path)
        unchanged = next(
            item for item in deliveries(campaign.path, campaign.id) if item.id == target.id
        )
        assert unchanged.state == "unknown"
        assert unchanged.attempts == 1
        assert message_count(api, target.message_id) == 0


def test_mailpit_and_api_restarts_preserve_campaign_and_accepted_letters(tmp_path: Path) -> None:
    with confirmed_campaign(tmp_path / "restart.sqlite3") as campaign, mailpit_api() as api:
        for _ in range(3):
            run_once(campaign.path)
        before = campaign.read()
        stored_before = deliveries(campaign.path, campaign.id)
        assert before.counters.sent == 3
        assert before.counters.pending == 5
        assert len(stored_before) == len({item.email for item in stored_before}) == 8
        assert {item.email for item in stored_before} == EXPECTED_EMAILS
        sent = [item for item in stored_before if item.state == "sent"]
        assert len(sent) == 3
        assert all(item.attempts == 1 for item in sent)
        raw_before = {item.message_id: raw_message(api, item.message_id) for item in sent}

        restart_mailpit()

        for item in stored_before:
            assert message_count(api, item.message_id) == (1 if item.state == "sent" else 0)
        for item in sent:
            raw_after = raw_message(api, item.message_id)
            assert raw_after == raw_before[item.message_id]
            accepted = BytesParser(policy=policy.default).parsebytes(raw_after)
            assert str(accepted["To"]) == item.email
            assert accepted.get_content().replace("\r\n", "\n") == BODY + "\n"

        # Each context starts and stops an independent OS process with the same database.
        for _ in range(2):
            with running_api(campaign.path) as restarted:
                response = restarted.get(campaign.endpoint)
                response.raise_for_status()
                assert CampaignDetail.model_validate(response.json()) == before
            assert deliveries(campaign.path, campaign.id) == stored_before
        assert campaign.read() == before
