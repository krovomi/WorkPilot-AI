"""CI survives GitHub release downloads that answer 5xx (2026-11-08, #784).

For a whole morning, every Electron zip and the Biome binary came back 504
from GitHub releases: each job died before its first test and every pull
request was red. Electron now goes through one composite action (Actions
cache, retries, checksums still checked by electron's install.js); Biome
comes from the npm registry.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
ACTION = ROOT / ".github" / "actions" / "fetch-electron" / "action.yml"


def _workflows() -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8") for p in WORKFLOWS.glob("*.yml")}


def test_electron_is_fetched_only_through_the_composite_action():
    direct = [
        name for name, text in _workflows().items() if "electron/install.js" in text
    ]
    assert not direct, f"use ./.github/actions/fetch-electron: {direct}"
    assert _workflows()["ci.yml"].count("uses: ./.github/actions/fetch-electron") == 3


def test_the_action_caches_retries_and_keeps_the_bundled_checksums():
    text = ACTION.read_text(encoding="utf-8")
    assert "actions/cache@" in text
    assert "electron_config_cache" in text
    assert "for wait in" in text
    # The bundled checksums.json is what verifies the zip: never turn it off.
    assert "electron_use_remote_checksums" not in text


def test_biome_comes_from_the_npm_registry():
    lint = _workflows()["lint.yml"]
    assert "biomejs/setup-biome@" not in lint
    assert (
        'npm install --global --no-fund --no-audit "@biomejs/biome@${BIOME_VERSION}"'
        in lint
    )
