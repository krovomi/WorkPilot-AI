"""The sidebar badge installs the release the backend and the release job run.

``apps/backend/rea/pin.json`` is the pin; ``REA_PIN`` in the frontend is a copy
the renderer can import, held equal here so the badge never installs a release
the runner then refuses as another version.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PIN = ROOT / "apps" / "backend" / "rea" / "pin.json"
FRONTEND = ROOT / "apps" / "frontend" / "src" / "shared" / "types" / "rea.ts"


def _frontend_pin() -> dict:
    text = FRONTEND.read_text(encoding="utf-8")
    block = re.search(r"export const REA_PIN = \{(.*?)\} as const;", text, re.S)
    assert block, "REA_PIN not found in shared/types/rea.ts"
    body = block.group(1)
    package = re.search(r'package:\s*"([^"]+)"', body)
    version = re.search(r'version:\s*"([^"]+)"', body)
    node = re.search(r"node:\s*\[([^\]]*)\]", body)
    assert package and version and node
    return {
        "package": package.group(1),
        "version": version.group(1),
        "node": re.findall(r'"([^"]+)"', node.group(1)),
    }


def test_the_badge_pins_the_same_release_as_the_backend():
    pin = json.loads(PIN.read_text(encoding="utf-8"))
    assert _frontend_pin() == {
        "package": pin["package"],
        "version": pin["version"],
        "node": pin["node"],
    }


def test_the_badge_installs_the_pin_without_install_scripts():
    handlers = (
        ROOT / "apps" / "frontend" / "src" / "main" / "ipc-handlers" / "rea-handlers.ts"
    ).read_text(encoding="utf-8")
    assert '["install", "-g", "--ignore-scripts", REA_SPEC]' in handlers
    assert "@latest" not in handlers


def test_the_catalog_entry_starts_the_pin_for_investigations_only():
    """Lot E: the MCP Marketplace's REA runs the pinned release, with compact
    schemas and the hot-cold catalog, offered to the `analyzer` (the agent of
    investigation tasks), and without the families that drive a device, a
    browser or a running program."""
    pin = json.loads(PIN.read_text(encoding="utf-8"))
    catalog = json.loads(
        (
            ROOT
            / "apps"
            / "frontend"
            / "src"
            / "shared"
            / "mcp-catalog"
            / "servers.json"
        ).read_text(encoding="utf-8")
    )
    [entry] = [s for s in catalog["servers"] if s["id"] == "rea"]
    assert entry["args"] == ["-y", f"{pin['package']}@{pin['version']}", "mcp"]
    assert entry["agents"] == ["analyzer"]
    env = entry["env"]
    assert env["REA_MCP_INPUT_SCHEMA_PROFILE"] == "compact"
    assert env["REA_MCP_OUTPUT_SCHEMA_PROFILE"] == "compact"
    assert env["REA_MCP_TOOL_CATALOG_PROFILE"] == "hot-cold"
    families = set(env["REA_MCP_TOOL_FAMILIES"].split(","))
    assert not families & {
        "frida",
        "adb",
        "browser",
        "javascript-runtime",
        "application",
    }
