"""Isolated, real-SMTP acceptance helpers; never used by the application."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
from fastapi.testclient import TestClient

from sqoch_api.app import create_app
from sqoch_api.notifications.fixtures import DEFAULT_FIXTURE
from sqoch_api.notifications.mailpit import SearchPage
from sqoch_api.notifications.schemas import CampaignDetail
from sqoch_api.notifications.store import connect_db, load_demo

ROOT = Path(__file__).resolve().parents[2]
MAILPIT_URL = "http://127.0.0.1:18025"
SMTP_PORT = "11025"
FUTURE_DATE = "2099-11-20T19:00:00+03:00"
BODY = "Мастер-класс «Керамика» перенесён на 20 ноября 2099 года, 19:00 Europe/Moscow."
CRASH_AFTER_ACCEPTANCE = 73


@dataclass(frozen=True)
class CampaignContext:
    path: Path
    id: UUID
    client: TestClient

    @property
    def endpoint(self) -> str:
        return f"/api/organizer/campaigns/{self.id}"

    def read(self) -> CampaignDetail:
        response = self.client.get(self.endpoint)
        response.raise_for_status()
        return CampaignDetail.model_validate(response.json())


@dataclass(frozen=True)
class StoredDelivery:
    id: str
    email: str
    message_id: str
    state: str
    attempts: int
    mime: bytes
    mailpit_id: str | None
    error_code: str | None


def integration_environment(path: Path) -> dict[str, str]:
    """Keep subprocesses local and prevent accidental provider use."""
    return {
        **os.environ,
        "SQOCH_DATABASE_PATH": str(path),
        "SQOCH_SMTP_HOST": "127.0.0.1",
        "SQOCH_SMTP_PORT": SMTP_PORT,
        "SQOCH_MAILPIT_URL": MAILPIT_URL,
        "DEEPSEEK_API_KEY": "",
        "LLM_PROVIDER": "deepseek",
    }


@contextmanager
def confirmed_campaign(path: Path) -> Iterator[CampaignContext]:
    """Use the real organizer API and an explicitly confirmed temporary campaign."""
    assert os.environ.get("SQOCH_SMTP_PORT") == SMTP_PORT
    assert os.environ.get("SQOCH_MAILPIT_URL") == MAILPIT_URL
    with (
        patch.dict(os.environ, integration_environment(path)),
        TestClient(
            create_app(frontend_dir=path.parent / "absent-frontend"),
            base_url="http://127.0.0.1",
        ) as client,
    ):
        load_demo(path, DEFAULT_FIXTURE)
        context = CampaignContext(path, uuid4(), client)
        created = client.put(context.endpoint, json={})
        assert created.status_code == 201
        saved = client.patch(
            context.endpoint,
            json={
                "expected_revision": 0,
                "event_id": "ceramics",
                "proposed_start": FUTURE_DATE,
                "subject": f"Sqoch SMTP acceptance {context.id}",
                "body": BODY,
                "text_reviewed": True,
                "reviewed_event_revision": 0,
            },
        )
        assert saved.status_code == 200
        preview = client.post(
            context.endpoint + "/preview",
            json={"expected_revision": saved.json()["revision"]},
        )
        assert preview.status_code == 200
        assert len(preview.json()["recipients"]) == 8
        confirmed = client.post(
            context.endpoint + "/confirm",
            json={"preview_token": preview.json()["token"]},
        )
        assert confirmed.status_code == 202
        assert context.read().counters.pending == 8
        yield context


def deliveries(path: Path, campaign_id: UUID) -> list[StoredDelivery]:
    with connect_db(path) as connection:
        return [
            StoredDelivery(
                id=str(row["id"]),
                email=str(row["email"]),
                message_id=str(row["message_id"]),
                state=str(row["state"]),
                attempts=int(row["attempts"]),
                mime=bytes(row["mime"]),
                mailpit_id=row["mailpit_message_id"],
                error_code=row["last_error_code"],
            )
            for row in connection.execute(
                "SELECT * FROM deliveries WHERE campaign_id=? ORDER BY created_at,id",
                (str(campaign_id),),
            )
        ]


def run_once(path: Path, *, mailpit_url: str = MAILPIT_URL) -> None:
    environment = integration_environment(path)
    environment["SQOCH_MAILPIT_URL"] = mailpit_url
    result = subprocess.run(
        [sys.executable, "-m", "sqoch_api.notifications.worker", "--once"],
        cwd=ROOT,
        env=environment,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def restart_mailpit() -> None:
    """Restart only the reserved test service, retaining its named database volume."""
    assert os.environ.get("SQOCH_SMTP_PORT") == SMTP_PORT
    assert os.environ.get("SQOCH_MAILPIT_URL") == MAILPIT_URL
    environment = {
        **{key: value for key, value in os.environ.items() if not key.startswith("COMPOSE_")},
        "COMPOSE_DISABLE_ENV_FILE": "1",
        "MAILPIT_SMTP_PORT": SMTP_PORT,
        "MAILPIT_HTTP_PORT": "18025",
    }
    for command in (["restart", "mailpit"], ["up", "-d", "--wait", "mailpit"]):
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--env-file",
                os.devnull,
                "-f",
                str(ROOT / "compose.yaml"),
                "-p",
                "sqoch-mailpit-tests",
                *command,
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=50,
            check=False,
        )
        assert result.returncode == 0, result.stderr


@contextmanager
def running_api(path: Path) -> Iterator[httpx.Client]:
    """Serve the real app in a fresh process on an inherited loopback-only socket."""
    program = """
import socket
import sys
import uvicorn
with socket.socket(fileno=int(sys.argv[1])) as listener:
    server = uvicorn.Server(uvicorn.Config(
        'sqoch_api.app:app', access_log=False, log_level='error'
    ))
    server.run(sockets=[listener])
"""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        port = listener.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, "-c", program, str(listener.fileno())],
            cwd=ROOT,
            env=integration_environment(path),
            pass_fds=(listener.fileno(),),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{port}",
            trust_env=False,
            follow_redirects=False,
            timeout=1,
        ) as api:
            deadline = time.monotonic() + 15
            while True:
                if process.poll() is not None:
                    _, stderr = process.communicate()
                    raise AssertionError(f"API exited before readiness: {stderr}")
                try:
                    response = api.get("/api/event")
                    response.raise_for_status()
                    break
                except httpx.TransportError:
                    assert time.monotonic() < deadline, "API did not become ready"
                    time.sleep(0.05)
            yield api
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=5)


def crash_after_smtp_acceptance(path: Path) -> None:
    """Exit in the process boundary after real 250, before record_result runs."""
    program = """
import os
from sqoch_api.notifications.config import load_config
from sqoch_api.notifications.smtp import send_delivery
from sqoch_api.notifications.worker import run_worker
config = load_config()
def accepted_then_exit(job):
    result = send_delivery(config.smtp_host, config.smtp_port, job.email, job.mime)
    os._exit(73 if result.state == 'sent' else 74)
run_worker(config, once=True, sender=accepted_then_exit)
"""
    result = subprocess.run(
        [sys.executable, "-c", program],
        cwd=ROOT,
        env=integration_environment(path),
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    assert result.returncode == CRASH_AFTER_ACCEPTANCE, result.stderr


def message_count(api: httpx.Client, message_id: str) -> int:
    response = api.get("/api/v1/search", params={"query": f"message-id:{message_id}"})
    response.raise_for_status()
    page = SearchPage.model_validate(response.json())
    # Own UUIDs have at most one expected hit. The API's `total` is mailbox-wide.
    assert all(hit.message_id.strip("<>") == message_id for hit in page.messages)
    assert len(page.messages) == page.messages_count
    return page.messages_count


def raw_message(api: httpx.Client, message_id: str) -> bytes:
    response = api.get("/api/v1/search", params={"query": f"message-id:{message_id}"})
    response.raise_for_status()
    page = SearchPage.model_validate(response.json())
    assert page.messages_count == 1
    response = api.get(f"/api/v1/message/{page.messages[0].id}/raw")
    response.raise_for_status()
    return response.content


def delete_own_message(api: httpx.Client, message_id: str) -> None:
    """Delete exactly one test-owned UUID; an empty IDs list would be unsafe."""
    response = api.get("/api/v1/search", params={"query": f"message-id:{message_id}"})
    response.raise_for_status()
    page = SearchPage.model_validate(response.json())
    assert page.messages_count == len(page.messages) == 1
    hit = page.messages[0]
    assert hit.message_id.strip("<>") == message_id
    assert hit.id
    api.request("DELETE", "/api/v1/messages", json={"IDs": [hit.id]}).raise_for_status()


@contextmanager
def mailpit_api() -> Iterator[httpx.Client]:
    with httpx.Client(
        base_url=MAILPIT_URL, trust_env=False, follow_redirects=False, timeout=5
    ) as api:
        original = api.get("/api/v1/chaos")
        original.raise_for_status()
        try:
            api.put("/api/v1/chaos", json={}).raise_for_status()
            yield api
        finally:
            api.put("/api/v1/chaos", json=original.json()).raise_for_status()
