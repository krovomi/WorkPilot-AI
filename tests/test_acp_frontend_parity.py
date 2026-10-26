"""The app and the backend start an ACP agent the same way.

The sidebar probes an ACP agent with `ACP_AGENT_ARGS` and its executable from
`AGENT_CLI_EXECUTABLES` (`shared/types/agent-cli.ts`); a build starts it with
`acp.command` from `capabilities/providers.yaml`. If the two drift, the
sidebar shows what one command declares while the build runs another.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "backend"))

from skills_registry.providers import load_providers  # noqa: E402

AGENT_CLI_TS = ROOT / "apps" / "frontend" / "src" / "shared" / "types" / "agent-cli.ts"


def _ts_object(name: str) -> dict[str, str]:
    """The body entries of `export const <name> ... = { ... };`, raw."""
    source = AGENT_CLI_TS.read_text(encoding="utf-8")
    match = re.search(rf"export const {name}\b[^=]*=\s*\{{(.*?)\n\}};", source, re.S)
    assert match, f"{name} not found in agent-cli.ts"
    entries = re.findall(r'^\s*"?([a-z-]+)"?:\s*(.+?),?$', match.group(1), re.M)
    return dict(entries)


def _ts_strings(raw: str) -> list[str]:
    return re.findall(r'"([^"]*)"', raw)


def test_every_acp_provider_is_probed_with_its_build_command() -> None:
    providers = {name: caps for name, caps in load_providers(ROOT).items() if caps.acp}
    assert providers, "no ACP provider in providers.yaml"
    args = {
        tool: _ts_strings(raw) for tool, raw in _ts_object("ACP_AGENT_ARGS").items()
    }
    executables = {
        tool: _ts_strings(raw)[0]
        for tool, raw in _ts_object("AGENT_CLI_EXECUTABLES").items()
    }
    assert set(args) == set(providers)
    for name, caps in providers.items():
        assert executables[name] == caps.acp.command[0], name
        assert args[name] == list(caps.acp.command[1:]), name
