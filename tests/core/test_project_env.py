"""Secrets the desktop app encrypted in `.workpilot/.env` (`enc:<base64>`).

The app passes them decrypted as environment variables; the CLI run without
it cannot decrypt them, so every reader of the file treats them as absent,
says so once, and lets a real environment variable supply the value.
"""

import logging
import os

import pytest
from core import project_env
from core.client import load_project_mcp_config
from core.project_env import drop_app_encrypted, is_app_encrypted, usable_file_value
from docintel import settings as docintel_settings
from libdocs import preflight
from services.notifications import NotificationChannel, NotificationService
from services.notifications.service import _parse_env_file

CIPHERTEXT = "enc:AAECAwQFBgcICQ=="


@pytest.fixture(autouse=True)
def _fresh_warnings():
    project_env._reset_warnings_for_tests()
    yield
    project_env._reset_warnings_for_tests()


@pytest.fixture
def project(tmp_path):
    (tmp_path / ".workpilot").mkdir()
    return tmp_path


def write_env(project, text):
    (project / ".workpilot" / ".env").write_text(text, encoding="utf-8")


def test_recognises_only_the_app_prefix():
    assert is_app_encrypted(CIPHERTEXT)
    assert not is_app_encrypted("ghp_plaintext")
    assert not is_app_encrypted("")
    assert not is_app_encrypted(None)


def test_an_encrypted_value_is_unusable_and_said_once(caplog):
    caplog.set_level(logging.WARNING, logger="core.project_env")

    assert usable_file_value("CONTEXT7_API_KEY", CIPHERTEXT) is None
    assert usable_file_value("CONTEXT7_API_KEY", CIPHERTEXT) is None
    assert usable_file_value("GITHUB_REPO", "owner/repo") == "owner/repo"

    warnings = [r for r in caplog.records if "CONTEXT7_API_KEY" in r.getMessage()]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "Export CONTEXT7_API_KEY" in message
    assert CIPHERTEXT not in message


def test_drop_app_encrypted_keeps_plain_values():
    assert drop_app_encrypted(
        {"A_TOKEN": CIPHERTEXT, "B_TOKEN": "plain", "REPO": "o/r"}
    ) == {"B_TOKEN": "plain", "REPO": "o/r"}


class TestContext7Key:
    def test_encrypted_key_is_not_loaded(self, project):
        write_env(project, f"CONTEXT7_ENABLED=true\nCONTEXT7_API_KEY={CIPHERTEXT}\n")

        config = load_project_mcp_config(project)

        assert config == {"CONTEXT7_ENABLED": "true"}

    def test_plaintext_key_is_still_loaded(self, project):
        write_env(project, "CONTEXT7_API_KEY=ctx7sk-plain\n")

        assert load_project_mcp_config(project)["CONTEXT7_API_KEY"] == "ctx7sk-plain"

    def test_libdocs_falls_back_to_the_environment(self, project, monkeypatch):
        write_env(project, f"CONTEXT7_API_KEY={CIPHERTEXT}\nLIBDOCS_ENABLED=true\n")
        monkeypatch.setenv("CONTEXT7_API_KEY", "ctx7sk-from-env")

        values = preflight.project_env(project)

        assert "CONTEXT7_API_KEY" not in values
        # What run_preflight builds: the environment wins over the file.
        assert {**values, **os.environ}["CONTEXT7_API_KEY"] == "ctx7sk-from-env"


class TestDocintelKeys:
    def test_encrypted_figma_token_reads_as_absent(self, project, monkeypatch):
        monkeypatch.delenv("FIGMA_ACCESS_TOKEN", raising=False)
        write_env(project, f"FIGMA_ACCESS_TOKEN={CIPHERTEXT}\n")

        assert docintel_settings.read_keys(project, ("FIGMA_ACCESS_TOKEN",)) == {}

    def test_environment_supplies_the_value(self, project, monkeypatch):
        monkeypatch.setenv("DOCINTEL_AZURE_KEY", "azure-from-env")
        write_env(project, f"DOCINTEL_AZURE_KEY={CIPHERTEXT}\n")

        assert docintel_settings.read_keys(project, ("DOCINTEL_AZURE_KEY",)) == {
            "DOCINTEL_AZURE_KEY": "azure-from-env"
        }


class TestNotificationWebhooks:
    def test_encrypted_webhook_url_is_not_parsed(self, project):
        write_env(
            project,
            f"SLACK_NOTIFICATIONS_ENABLED=true\nSLACK_WEBHOOK_URL={CIPHERTEXT}\n",
        )

        assert _parse_env_file(project / ".workpilot" / ".env") == {
            "SLACK_NOTIFICATIONS_ENABLED": "true"
        }

    def test_environment_url_is_used(self, project, monkeypatch):
        monkeypatch.setenv(
            "SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T000/B000/XXXX"
        )
        write_env(
            project,
            f"SLACK_NOTIFICATIONS_ENABLED=true\nSLACK_WEBHOOK_URL={CIPHERTEXT}\n",
        )

        service = NotificationService.from_env(project)

        slack = [c for c in service.channels if c.channel == NotificationChannel.SLACK]
        assert [c.webhook_url for c in slack] == [
            "https://hooks.slack.com/services/T000/B000/XXXX"
        ]

    def test_without_the_environment_the_channel_is_skipped(self, project, monkeypatch):
        monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
        monkeypatch.delenv("SLACK_NOTIFICATIONS_ENABLED", raising=False)
        write_env(
            project,
            f"SLACK_NOTIFICATIONS_ENABLED=true\nSLACK_WEBHOOK_URL={CIPHERTEXT}\n",
        )

        service = NotificationService.from_env(project)

        assert all(c.channel != NotificationChannel.SLACK for c in service.channels)
