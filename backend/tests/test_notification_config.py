from pathlib import Path

import pytest

from sqoch_api.notifications.config import ConfigurationError, load_config


def test_defaults_are_local_without_requiring_a_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    config = load_config({})
    assert config.database_path == tmp_path / "data" / "sqoch.sqlite3"
    assert config.smtp_host == "127.0.0.1"
    assert config.smtp_port == 1025
    assert config.mailpit_url == "http://127.0.0.1:8025"
    assert config.deepseek_model == "deepseek-flash"
    assert config.deepseek_api_key is None
    assert not config.database_path.exists()


def test_environment_is_read_at_each_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SQOCH_DATABASE_PATH", str(tmp_path / "first.sqlite3"))
    first = load_config()
    monkeypatch.setenv("SQOCH_DATABASE_PATH", str(tmp_path / "second.sqlite3"))
    assert first.database_path == tmp_path / "first.sqlite3"
    assert load_config().database_path == tmp_path / "second.sqlite3"


def test_database_path_is_canonical_without_creating_data(tmp_path: Path) -> None:
    directory = tmp_path / "actual"
    directory.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(directory, target_is_directory=True)
    config = load_config({"SQOCH_DATABASE_PATH": str(alias / "state.sqlite3")})
    assert config.database_path == directory / "state.sqlite3"
    assert not config.database_path.exists()


def test_integration_ports_can_be_isolated_and_secret_is_redacted(tmp_path: Path) -> None:
    secret = "fixture-secret-never-print"
    config = load_config(
        {
            "SQOCH_DATABASE_PATH": str(tmp_path / "test.sqlite3"),
            "SQOCH_SMTP_HOST": "127.0.0.1",
            "SQOCH_SMTP_PORT": "11025",
            "SQOCH_MAILPIT_URL": "http://127.0.0.1:18025/",
            "DEEPSEEK_MODEL": "fixture-model",
            "DEEPSEEK_API_KEY": secret,
        }
    )
    assert config.smtp_port == 11025
    assert config.mailpit_url == "http://127.0.0.1:18025"
    assert config.deepseek_model == "fixture-model"
    assert config.deepseek_api_key is not None
    assert config.deepseek_api_key.get_secret_value() == secret
    assert secret not in repr(config)
    assert secret not in str(config.deepseek_api_key)


@pytest.mark.parametrize("host", ["smtp.example.com", "localhost", "0.0.0.0", "127.0.0.2"])
def test_smtp_cannot_target_a_nonliteral_host(host: str) -> None:
    with pytest.raises(ConfigurationError, match="SQOCH_SMTP_HOST") as error:
        load_config({"SQOCH_SMTP_HOST": host})
    assert host not in str(error.value)


@pytest.mark.parametrize("port", ["0", "65536", "-1", "invalid", "1.5", "1025\n"])
def test_smtp_port_is_a_strict_tcp_port(port: str) -> None:
    with pytest.raises(ConfigurationError, match="SQOCH_SMTP_PORT"):
        load_config({"SQOCH_SMTP_PORT": port})


@pytest.mark.parametrize(
    "url",
    [
        "http://mailpit.example.com:8025",
        "http://localhost:8025",
        "https://127.0.0.1:8025",
        "http://127.0.0.1:8025/api",
        "http://user:secret@127.0.0.1:8025",
        "http://127.0.0.1:8025?redirect=http://example.com",
        "http://127.0.0.1:8025#fragment",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:8025\n",
    ],
)
def test_mailpit_url_cannot_escape_the_local_base(url: str) -> None:
    with pytest.raises(ConfigurationError, match="SQOCH_MAILPIT_URL") as error:
        load_config({"SQOCH_MAILPIT_URL": url})
    assert url not in str(error.value)


@pytest.mark.parametrize("setting", ["SQOCH_DATABASE_PATH", "DEEPSEEK_MODEL"])
def test_required_nonsecret_settings_cannot_be_empty(setting: str) -> None:
    with pytest.raises(ConfigurationError, match=setting):
        load_config({setting: ""})


def test_invalid_key_is_never_echoed_in_error() -> None:
    key = "fixture-secret\r\nheader"
    with pytest.raises(ConfigurationError, match="DEEPSEEK_API_KEY") as error:
        load_config({"DEEPSEEK_API_KEY": key})
    assert key not in str(error.value)
    assert "fixture-secret" not in str(error.value)


def test_explicit_deepseek_provider_is_supported() -> None:
    assert load_config({"LLM_PROVIDER": "deepseek"}).deepseek_model == "deepseek-flash"


def test_other_provider_is_rejected_instead_of_ignored() -> None:
    with pytest.raises(ConfigurationError, match="LLM_PROVIDER"):
        load_config({"LLM_PROVIDER": "other-provider"})
