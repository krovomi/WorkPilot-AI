"""Which open standards reach each provider, checked against the code (P4).

`capabilities/providers.yaml` says, per provider, how MCP tools and the
project's instruction file reach the model. A claim there is only worth
something if the code agrees, so each value is checked against what the
client does: a provider said to bridge MCP runs a client that has the bridge,
one said to get AGENTS.md injected is built from the prompt that carries it,
and `own` (the CLI loads its own config) is only for a CLI. The versions the
conformance table quotes are the ones the code speaks.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from skills_registry.providers import (  # noqa: E402
    INSTRUCTION_SUPPORT,
    MCP_SUPPORT,
    load_providers,
)

PROVIDERS = load_providers(REPO_ROOT)
WITH_ADAPTER = sorted(name for name, caps in PROVIDERS.items() if caps.adapter)
STANDARDS_DOC = REPO_ROOT / "docs" / "architecture" / "standards.md"


def _adapter_class(name: str) -> type:
    """The class `adapter` names, from the client modules."""
    import importlib
    import pkgutil

    import core.agent_clients as package

    adapter = PROVIDERS[name].adapter
    modules = ["core.codex_cli_client"] + [
        f"core.agent_clients.{m.name}" for m in pkgutil.iter_modules(package.__path__)
    ]
    for module in modules:
        found = getattr(importlib.import_module(module), adapter, None)
        if isinstance(found, type):
            return found
    raise AssertionError(f"{name}: no client class named {adapter}")


def _prompt_hints() -> dict[str, set[bool]]:
    """For each client class `create_agent_client` builds, the `tool_use_hint`
    of the prompt it is built with (the hint is what adds AGENTS.md)."""
    tree = ast.parse((BACKEND / "core" / "client.py").read_text(encoding="utf-8"))
    hints: dict[str, set[bool]] = {}
    for fn in tree.body:
        if not (isinstance(fn, ast.FunctionDef) and fn.name.endswith("_client")):
            continue
        used: set[bool] = set()
        built: set[str] = set()
        for node in ast.walk(fn):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and func.attr == "prompt"
                and isinstance(func.value, ast.Name)
                and func.value.id == "req"
            ):
                for kw in node.keywords:
                    if kw.arg == "tool_use_hint" and isinstance(kw.value, ast.Constant):
                        used.add(bool(kw.value.value))
            if isinstance(func, ast.Name) and func.id.endswith("AgentClient"):
                built.add(func.id)
        for cls in built:
            hints.setdefault(cls, set()).update(used)
    return hints


HINTS = _prompt_hints()


def _raw() -> dict:
    import yaml

    path = REPO_ROOT / "capabilities" / "providers.yaml"
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_every_adapter_declares_its_standards():
    """`unverified` is a declaration too; a missing block is an oversight."""
    missing = [name for name in WITH_ADAPTER if "standards" not in (_raw()[name] or {})]
    assert not missing, f"declare `standards` for {missing} in providers.yaml"


def test_a_degraded_provider_declares_nothing():
    """It runs as `degrades_to`: a claim of its own would be about nothing."""
    declared = [
        name
        for name, cfg in _raw().items()
        if not (cfg or {}).get("adapter") and "standards" in (cfg or {})
    ]
    assert not declared


@pytest.mark.parametrize("name", WITH_ADAPTER)
def test_mcp_claim_matches_the_client(name):
    from core.agent_clients.cli_subprocess import CliSubprocessAgentClient

    cls = _adapter_class(name)
    claim = PROVIDERS[name].mcp
    has_bridge = hasattr(cls, "_bridge_mcp_tools")
    if claim == "bridged" or has_bridge:
        assert claim == "bridged" and has_bridge, (
            f"{name}: {cls.__name__} {'has' if has_bridge else 'has no'} MCP bridge, "
            f"providers.yaml says {claim!r}"
        )
    if claim == "native":
        assert cls.__name__ == "ClaudeAgentClient", (
            "only the Claude SDK takes MCP servers"
        )
    if claim == "own":
        assert issubclass(cls, CliSubprocessAgentClient), f"{name} is not a CLI"


@pytest.mark.parametrize("name", WITH_ADAPTER)
def test_instructions_claim_matches_the_prompt(name):
    cls = _adapter_class(name).__name__
    claim = PROVIDERS[name].instructions
    assert cls in HINTS, f"no factory in core/client.py builds {cls}"
    hints = HINTS[cls]
    if claim == "injected":
        assert hints == {True}, (
            f"{name}: {cls} is built without AGENTS.md in its prompt"
        )
    else:
        assert True not in hints, (
            f"{name}: {cls} gets AGENTS.md injected, providers.yaml says {claim!r}"
        )


def test_the_vocabulary_is_closed(tmp_path):
    (tmp_path / "capabilities").mkdir()
    (tmp_path / "capabilities" / "providers.yaml").write_text(
        "x:\n  adapter: A\n  standards:\n    mcp: maybe\n", encoding="utf-8"
    )
    with pytest.raises(ValueError, match="standards.mcp"):
        load_providers(tmp_path)
    assert "unverified" in MCP_SUPPORT and "unverified" in INSTRUCTION_SUPPORT


def test_the_table_quotes_the_versions_the_code_speaks():
    from board_mcp.server import PROTOCOL_VERSIONS
    from core.agent_clients.acp import ACP_PROTOCOL_VERSION
    from mcp_tasks.wire import MODERN_VERSION

    text = STANDARDS_DOC.read_text(encoding="utf-8")
    assert f"MCP `{MODERN_VERSION}`" in text
    for version in PROTOCOL_VERSIONS:
        assert f"`{version}`" in text
    assert f"ACP version `{ACP_PROTOCOL_VERSION}`" in text
    for name in WITH_ADAPTER:
        assert f"`{name}`" in text, f"{name} is missing from the per-provider table"
