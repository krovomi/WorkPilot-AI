"""The MCP Marketplace catalog only offers servers the backend starts.

`apps/frontend/src/shared/mcp-catalog/servers.json` is what the marketplace
installs into a project's `CUSTOM_MCP_SERVERS`. Every entry, filled the way
`shared/mcp-catalog/install.ts` fills it, must pass
`core.client._validate_custom_mcp_server`: otherwise the agent silently runs
without the server the user just installed. The `env` a catalog server
carries is checked here too, with the refusals that keep it from loading code
into the launcher.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from core.client import _custom_servers, _validate_custom_mcp_server

CATALOG = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "frontend"
    / "src"
    / "shared"
    / "mcp-catalog"
    / "servers.json"
)
PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _servers() -> list[dict]:
    return json.loads(CATALOG.read_text(encoding="utf-8"))["servers"]


def _fill(text: str, values: dict[str, str]) -> str | None:
    """`install.ts`'s `fill`: None when a placeholder names an empty value."""
    empty = False

    def sub(match: re.Match[str]) -> str:
        nonlocal empty
        value = values.get(match.group(1), "").strip()
        empty = empty or not value
        return value

    out = PLACEHOLDER.sub(sub, text)
    return None if empty else out


def _build(entry: dict, values: dict[str, str]) -> dict:
    """`install.ts`'s `buildCatalogServer` for a fully filled form."""
    base = {"id": entry["id"], "name": entry["name"], "description": "x"}
    texts = [*entry.get("args", []), entry.get("url", "")]
    texts += list(entry.get("headers", {}).values())
    referenced = {name for text in texts for name in PLACEHOLDER.findall(text)}
    if entry["transport"] == "stdio":
        args = [a for a in (_fill(a, values) for a in entry["args"]) if a is not None]
        env = dict(entry.get("env", {}))
        for var in entry["vars"]:
            if values.get(var["name"]) and var["name"] not in referenced:
                env[var["name"]] = values[var["name"]]
        server = {**base, "type": "command", "command": entry["command"], "args": args}
        if env:
            server["env"] = env
        return server
    headers = {
        k: v
        for k, v in ((k, _fill(v, values)) for k, v in entry.get("headers", {}).items())
        if v is not None
    }
    server = {**base, "type": "http", "url": _fill(entry["url"], values)}
    if headers:
        server["headers"] = headers
    return server


CATALOG_IDS = [s["id"] for s in _servers()]


@pytest.mark.parametrize("entry", _servers(), ids=CATALOG_IDS)
def test_every_catalog_server_passes_the_backend_validation(entry):
    values = {v["name"]: f"dummy-{v['name'].lower()}" for v in entry["vars"]}
    assert _validate_custom_mcp_server(_build(entry, values)), entry["id"]


@pytest.mark.parametrize("entry", _servers(), ids=CATALOG_IDS)
def test_catalog_server_with_only_required_values_passes(entry):
    values = {
        v["name"]: f"dummy-{v['name'].lower()}" for v in entry["vars"] if v["required"]
    }
    assert _validate_custom_mcp_server(_build(entry, values)), entry["id"]


def test_catalog_is_large_and_ids_are_unique():
    assert len(CATALOG_IDS) >= 35
    assert len(set(CATALOG_IDS)) == len(CATALOG_IDS)


def test_custom_server_env_reaches_the_sdk_config():
    server = {
        "id": "notion",
        "name": "Notion",
        "type": "command",
        "command": "npx",
        "args": ["-y", "@notionhq/notion-mcp-server"],
        "env": {"NOTION_TOKEN": "ntn_dummy"},  # pragma: allowlist secret
    }
    assert _validate_custom_mcp_server(server)
    started = _custom_servers({"notion"}, {"CUSTOM_MCP_SERVERS": [server]})
    assert started["notion"]["env"] == {
        "NOTION_TOKEN": "ntn_dummy"
    }  # pragma: allowlist secret


def _command_server(env: object) -> dict:
    return {
        "id": "x",
        "name": "X",
        "type": "command",
        "command": "npx",
        "args": ["-y", "pkg"],
        "env": env,
    }


@pytest.mark.parametrize(
    "env",
    [
        {"NODE_OPTIONS": "--require /tmp/evil.js"},
        {"LD_PRELOAD": "/tmp/evil.so"},
        {"dyld_insert_libraries": "/tmp/evil.dylib"},
        {"PATH": "/tmp/evil"},
        {"PYTHONPATH": "/tmp/evil"},
        {"NPM_CONFIG_REGISTRY": "https://evil.example"},
        {"UV_INDEX_URL": "https://evil.example"},
        {"PIP_INDEX_URL": "https://evil.example"},
        {"BASH_ENV": "/tmp/evil.sh"},
        {"CLAUDE_CODE_OAUTH_TOKEN": "x"},
        {"BAD-NAME": "x"},
        {"OK": 1},
        {"OK": "a\x00b"},
        {"OK": "x" * 9000},
        {f"V{i}": "x" for i in range(33)},
        ["NOT", "A", "MAP"],
    ],
)
def test_env_that_changes_what_runs_is_refused(env):
    assert not _validate_custom_mcp_server(_command_server(env))


def test_http_server_cannot_carry_env():
    server = {
        "id": "x",
        "name": "X",
        "type": "http",
        "url": "https://example.com/mcp",
        "env": {"TOKEN": "x"},
    }
    assert not _validate_custom_mcp_server(server)


def test_plain_api_key_env_is_accepted():
    assert _validate_custom_mcp_server(
        _command_server(
            {"SENTRY_AUTH_TOKEN": "sntryu_dummy", "SENTRY_HOST": "sentry.io"}
        )
    )
