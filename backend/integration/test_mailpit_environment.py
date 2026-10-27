"""Opt-in real SMTP checks, against a dedicated Compose project only."""

import os
import smtplib
from email.message import EmailMessage
from uuid import uuid4

import httpx


def test_smtp_search_and_reproducible_sender_failure() -> None:
    port = int(os.environ["SQOCH_SMTP_PORT"])
    url = os.environ["SQOCH_MAILPIT_URL"]
    assert url == "http://127.0.0.1:18025"
    assert port == 11025
    message_id = f"environment-{uuid4()}@sqoch.local"
    message = EmailMessage()
    message["From"] = "organizer@example.com"
    message["To"] = "environment@example.com"
    message["Message-ID"] = f"<{message_id}>"
    message["Subject"] = "Sqoch local SMTP check"
    message.set_content("Local Mailpit only")
    with httpx.Client(base_url=url, trust_env=False, follow_redirects=False, timeout=5) as api:
        original = api.get("/api/v1/chaos")
        original.raise_for_status()
        try:
            api.put("/api/v1/chaos", json={}).raise_for_status()
            with smtplib.SMTP("127.0.0.1", port, timeout=5) as smtp:
                assert smtp.send_message(message) == {}
            found = api.get("/api/v1/search", params={"query": f"message-id:{message_id}"})
            found.raise_for_status()
            data = found.json()
            assert data["messages_count"] == 1
            assert len(data["messages"]) == 1
            item = data["messages"][0]
            assert item["MessageID"] == message_id
            assert item["To"] == [{"Name": "", "Address": "environment@example.com"}]
            raw = api.get(f"/api/v1/message/{item['ID']}/raw")
            raw.raise_for_status()
            assert "Local Mailpit only" in raw.text
            api.put(
                "/api/v1/chaos", json={"Sender": {"ErrorCode": 451, "Probability": 100}}
            ).raise_for_status()
            with smtplib.SMTP("127.0.0.1", port, timeout=5) as smtp:
                smtp.ehlo()
                code, _ = smtp.mail("organizer@example.com")
                assert code == 451
            repeated = api.get("/api/v1/search", params={"query": f"message-id:{message_id}"})
            repeated.raise_for_status()
            assert repeated.json()["messages_count"] == 1
        finally:
            api.put("/api/v1/chaos", json=original.json()).raise_for_status()
