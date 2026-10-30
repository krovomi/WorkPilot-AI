"""The pinned tool versions live in one place each, and the rules name them.

Biome is read by lint.yml from apps/frontend/package.json, ruff is installed
by lint.yml; the rules (docs/rules/workflow.md) state both. A bump that moves
one of them without the others is a "passes locally, fails in CI" waiting to
happen, which is how package.json reached 2.5.15 while CI ran 2.5.11.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINT = (ROOT / ".github" / "workflows" / "lint.yml").read_text(encoding="utf-8")
RULES = (ROOT / "docs" / "rules" / "workflow.md").read_text(encoding="utf-8")


def _rule_pin(tool: str) -> str:
    match = re.search(rf"{tool} `([0-9][0-9.]*)`", RULES)
    assert match, f"docs/rules/workflow.md no longer names the {tool} version"
    return match.group(1)


def test_biome_is_pinned_exactly_where_the_rules_say():
    package = json.loads(
        (ROOT / "apps" / "frontend" / "package.json").read_text(encoding="utf-8")
    )
    assert package["devDependencies"]["@biomejs/biome"] == _rule_pin("Biome")


def test_lint_reads_biome_from_package_json_rather_than_repeating_it():
    setup = LINT[LINT.index("Setup Biome") :]
    setup = setup[: setup.index("Run Biome")]
    assert "steps.biome.outputs.version" in setup
    assert not re.search(r"version:\s*['\"]?\d", setup)


def test_lint_installs_the_ruff_the_rules_name():
    assert f"ruff=={_rule_pin('ruff')}" in LINT


def test_lint_runs_the_pyright_the_rules_name():
    pin = _rule_pin("pyright")
    assert f"pyright=={pin}" in LINT
    # pip's pyright fetches the npm release named here, not its own default.
    assert f"PYRIGHT_PYTHON_FORCE_VERSION: '{pin}'" in LINT


def test_the_python_lock_is_checked_with_the_uv_ci_installs():
    action = (
        ROOT / ".github" / "actions" / "setup-python-backend" / "action.yml"
    ).read_text(encoding="utf-8")
    pinned = re.search(r'version: "([0-9.]+)"', action)
    assert pinned, "setup-python-backend must pin uv"
    assert f"uv=={pinned.group(1)}" in LINT
