"""The Plugin Marketplace installs skills the backend reads and accepts.

`apps/frontend/src/shared/plugin-catalog/plugins.json` holds the plugins;
installing one writes `<project>/.agents/skills/<id>/SKILL.md`
(`main/plugin-marketplace/project-skills.ts`, `renderPluginSkill`). Each body
must pass the injection gate that refuses a skill speaking past its reader,
and the written file must be what the Kanban slash commands list and run.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from skills_registry.frontmatter import parse_frontmatter, workpilot_meta
from skills_registry.injection_gate import scan_skill_body
from slash_commands.api import _resolve_command_body, _scan_skills_dir

CATALOG = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "frontend"
    / "src"
    / "shared"
    / "plugin-catalog"
    / "plugins.json"
)
SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _plugins() -> list[dict]:
    return json.loads(CATALOG.read_text(encoding="utf-8"))["plugins"]


def _render(plugin: dict) -> str:
    """`renderPluginSkill` of project-skills.ts."""
    return "\n".join(
        [
            "---",
            f"name: {plugin['id']}",
            f"description: {json.dumps(plugin['skill']['description'], ensure_ascii=False)}",
            "metadata:",
            "  workpilot:",
            f"    plugin: {plugin['id']}",
            f"    plugin-type: {plugin['type']}",
            "---",
            "",
            plugin["skill"]["body"].rstrip(),
            "",
        ]
    )


IDS = [p["id"] for p in _plugins()]


def test_catalog_is_large_with_unique_skill_names():
    assert len(IDS) >= 20
    assert len(set(IDS)) == len(IDS)
    assert all(SKILL_NAME.match(i) and len(i) <= 64 for i in IDS)


@pytest.mark.parametrize("plugin", _plugins(), ids=IDS)
def test_skill_body_passes_the_injection_gate(plugin):
    verdict = scan_skill_body(plugin["skill"]["body"], plugin["id"])
    assert not verdict.refused, verdict.summary
    assert verdict.threat_level != "blocked", verdict.findings


@pytest.mark.parametrize("plugin", _plugins(), ids=IDS)
def test_rendered_skill_parses_with_its_marker(plugin):
    meta, body = parse_frontmatter(_render(plugin))
    assert meta["name"] == plugin["id"]
    assert meta["description"] == plugin["skill"]["description"]
    assert workpilot_meta(meta)["plugin"] == plugin["id"]
    assert body.strip() == plugin["skill"]["body"].strip()
    assert 20 <= len(meta["description"]) <= 1024


def test_installed_skill_is_a_kanban_slash_command(tmp_path):
    plugin = _plugins()[0]
    skill = tmp_path / ".agents" / "skills" / plugin["id"] / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(_render(plugin), encoding="utf-8")

    listed = _scan_skills_dir(tmp_path, "project")
    assert [c["name"] for c in listed] == [plugin["id"]]
    assert listed[0]["description"] == plugin["skill"]["description"]

    body = _resolve_command_body(tmp_path, plugin["id"])
    assert body is not None and body.strip() == plugin["skill"]["body"].strip()
