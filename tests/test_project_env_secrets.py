"""A project's `.workpilot/.env` holds two kinds of secrets (rule S1).

The desktop app stores the tokens the backend only takes from its process
environment as `enc:` safeStorage ciphertext, which Python cannot read, and
decrypts them into the environment of each subprocess it starts. It leaves in
clear (0600, and named by the UI) the ones the backend reads from the file
itself, in processes started without the project's environment. The split is
`apps/frontend/src/shared/constants/project-env-secrets.json`; these tests
hold the backend to it:

- no reader of the file hands out an `enc:` value: a reader that started
  taking an encrypted key from the file would get ciphertext, not a token;
- every `readable` key still reaches the reader that needs it from the file;
- every module that opens the file is one of the readers checked here.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SECRETS = json.loads(
    (REPO / "apps/frontend/src/shared/constants/project-env-secrets.json").read_text(
        encoding="utf-8"
    )
)

CONTEXT7_KEY = "ctx7sk-readable-0000"
FIGMA_TOKEN = "figd_readable0000"
AZURE_KEY = "azure-readable-0000"
WEBHOOKS = {
    "TEAMS_WEBHOOK_URL": "https://example.com/teams-webhook-0000",
    "SLACK_WEBHOOK_URL": "https://example.com/slack-webhook-0000",
    "DISCORD_WEBHOOK_URL": "https://example.com/discord-webhook-0000",
    "GOOGLE_CHAT_WEBHOOK_URL": "https://example.com/google-chat-webhook-0000",
    "NOTIFY_WEBHOOK_URL": "https://example.com/webhook/0000",
}
MCP_SERVERS = [
    {
        "id": "internal",
        "name": "Internal",
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {"Authorization": "Bearer mcp-readable-0000"},
    }
]

#: The modules that build `<project>/.workpilot/.env` themselves.
READER_MODULES = {
    "apps/backend/core/client.py",
    "apps/backend/core/mcp_tools.py",
    "apps/backend/docintel/settings.py",
    "apps/backend/libdocs/preflight.py",
    "apps/backend/rtk/settings.py",
    "apps/backend/services/notifications/service.py",
    "apps/backend/uiux/settings.py",
    "apps/backend/verify/settings.py",
    "apps/backend/watermarks/settings.py",
}
# Modules that name the file without reading it. The OS sandbox hides it from
# the agent's process (`tests/os_sandbox/test_hosts_and_policy.py` checks it).
NAMING_ONLY_MODULES = {"apps/backend/os_sandbox/policy.py"}
_OPENS_PROJECT_ENV = re.compile(
    r"""(?:\.workpilot["']|_WORKPILOT_DIR|_AUTO_CLAUDE_DIR)\s*/\s*["']\.env["']"""
)


def _ciphertext(key: str) -> str:
    """What the desktop app writes for an encrypted key: never a usable token."""
    return "enc:" + base64.b64encode(f"ciphertext-of-{key}".encode()).decode()


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    lines = [f"{key}={_ciphertext(key)}" for key in SECRETS["encrypted"]]
    lines += [
        f"CONTEXT7_API_KEY={CONTEXT7_KEY}",
        f"CUSTOM_MCP_SERVERS={json.dumps(MCP_SERVERS)}",
        f"FIGMA_ACCESS_TOKEN={FIGMA_TOKEN}",
        f"DOCINTEL_AZURE_KEY={AZURE_KEY}",
        "TEAMS_NOTIFICATIONS_ENABLED=true",
        "SLACK_NOTIFICATIONS_ENABLED=true",
        "DISCORD_NOTIFICATIONS_ENABLED=true",
        "GOOGLE_CHAT_NOTIFICATIONS_ENABLED=true",
        "NOTIFY_WEBHOOK_ENABLED=true",
        *(f"{key}={url}" for key, url in WEBHOOKS.items()),
        "RTK_ENABLED=true",
        "UIUX_ENABLED=true",
        "DOCINTEL_ENABLED=true",
        "CONTEXT7_ENABLED=true",
    ]
    env_file = tmp_path / ".workpilot" / ".env"
    env_file.parent.mkdir()
    env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    # The file is the only source here: a key exported by the caller's shell
    # would hide what the reader takes from it.
    for key in [*SECRETS["encrypted"], *SECRETS["readable"]]:
        monkeypatch.delenv(key, raising=False)
    return tmp_path


def _load_mcp_config(project: Path) -> object:
    from core.client import load_project_mcp_config

    return load_project_mcp_config(project)


def _mcp_servers(project: Path) -> object:
    from core.mcp_tools import _read_project_env_servers

    return _read_project_env_servers(str(project))


def _libdocs(project: Path) -> object:
    from libdocs.preflight import project_env

    return project_env(project)


def _docintel(project: Path) -> object:
    from docintel import figma, settings

    return {
        **settings.project_env(project),
        **settings.read_keys(project, (figma.TOKEN_ENV,)),
    }


def _notifications(project: Path) -> object:
    from services.notifications.service import NotificationService

    return [c.webhook_url for c in NotificationService.from_env(project).channels]


def _rtk(project: Path) -> object:
    from rtk.settings import project_env

    return project_env(project)


def _watermarks(project: Path) -> object:
    from watermarks.settings import project_env

    return project_env(project)


def _verify(project: Path) -> object:
    from verify.settings import project_env

    return project_env(project)


def _uiux(project: Path) -> object:
    from uiux.settings import read_settings

    return read_settings(project)


READERS: dict[str, Callable[[Path], object]] = {
    "core.client.load_project_mcp_config": _load_mcp_config,
    "core.mcp_tools._read_project_env_servers": _mcp_servers,
    "libdocs.preflight.project_env": _libdocs,
    "docintel.settings": _docintel,
    "services.notifications": _notifications,
    "rtk.settings.project_env": _rtk,
    "watermarks.settings.project_env": _watermarks,
    "verify.settings.project_env": _verify,
    "uiux.settings.read_settings": _uiux,
}


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for item in value.values() for s in _strings(item)]
    if isinstance(value, (list, tuple)):
        return [s for item in value for s in _strings(item)]
    return []


@pytest.mark.parametrize("reader", sorted(READERS))
def test_no_reader_hands_out_ciphertext(project: Path, reader: str) -> None:
    leaked = [s for s in _strings(READERS[reader](project)) if "enc:" in s]
    assert leaked == [], (
        f"{reader} read an encrypted key from .workpilot/.env. The desktop app "
        "passes those through the environment; take it from os.environ, or move "
        "the key to 'readable' in project-env-secrets.json."
    )


def test_readable_keys_reach_the_readers_that_need_them(project: Path) -> None:
    assert _load_mcp_config(project)["CONTEXT7_API_KEY"] == CONTEXT7_KEY
    assert _libdocs(project)["CONTEXT7_API_KEY"] == CONTEXT7_KEY
    servers = _mcp_servers(project)
    assert [s["headers"] for s in servers] == [MCP_SERVERS[0]["headers"]]
    docintel = _docintel(project)
    assert docintel["FIGMA_ACCESS_TOKEN"] == FIGMA_TOKEN
    assert docintel["DOCINTEL_AZURE_KEY"] == AZURE_KEY
    assert sorted(_notifications(project)) == sorted(WEBHOOKS.values())


def test_the_readable_list_is_what_the_backend_reads_from_the_file() -> None:
    assert set(SECRETS["readable"]) == {
        "CONTEXT7_API_KEY",
        "CUSTOM_MCP_SERVERS",
        "FIGMA_ACCESS_TOKEN",
        "DOCINTEL_AZURE_KEY",
        *WEBHOOKS,
    }
    assert not set(SECRETS["encrypted"]) & set(SECRETS["readable"])


def test_every_module_opening_the_file_is_checked_here() -> None:
    opening = {
        path.relative_to(REPO).as_posix()
        for root in (REPO / "apps/backend", REPO / "src")
        for path in root.rglob("*.py")
        if "tests" not in path.parts
        and _OPENS_PROJECT_ENV.search(path.read_text(encoding="utf-8"))
    }
    assert opening == READER_MODULES | NAMING_ONLY_MODULES, (
        "A module reads .workpilot/.env that this test does not know: say which "
        "keys it takes in project-env-secrets.json and add it to READERS."
    )
