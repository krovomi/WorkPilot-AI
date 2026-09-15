"""AnyDoc is available to consumer projects and survives desktop packaging."""

import json
import shutil
from pathlib import Path

from slash_commands import api

ROOT = Path(__file__).resolve().parents[1]
NAME = "convert-documents-to-markdown"


def test_external_project_can_list_and_load_anydoc(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    commands = api.list_slash_commands(str(tmp_path))["commands"]
    matches = [c for c in commands if c["name"] == NAME]
    assert len(matches) == 1
    assert matches[0]["source"] == "built-in"
    body = api.get_slash_command_body(str(tmp_path), NAME)["body"]
    assert "@firecrawl/anydoc" in body
    assert not (tmp_path / ".agents").exists()


def test_project_skill_overrides_bundled_anydoc(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    skill = tmp_path / ".agents" / "skills" / NAME / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(f"---\nname: {NAME}\n---\nProject instructions", encoding="utf-8")
    commands = api.list_slash_commands(str(tmp_path))["commands"]
    assert len([c for c in commands if c["name"] == NAME]) == 1
    assert (
        api.get_slash_command_body(str(tmp_path), NAME)["body"]
        == "Project instructions"
    )


def test_packaged_skill_loads_without_repository(tmp_path, monkeypatch):
    from skills_registry import bundled

    config = json.loads(
        (ROOT / "apps/frontend/package.json").read_text(encoding="utf-8")
    )
    resource = next(
        r
        for r in config["build"]["extraResources"]
        if r["to"] == f"backend/skills_registry/bundled/{NAME}"
    )
    source = ROOT / "apps/frontend" / resource["from"]
    destination = tmp_path / "backend/skills_registry/bundled" / NAME
    shutil.copytree(source, destination)
    monkeypatch.setattr(
        bundled, "__file__", str(tmp_path / "backend/skills_registry/bundled.py")
    )
    assert "@firecrawl/anydoc" in bundled.load_bundled_skill(NAME)[1]


def test_unknown_bundled_skill_is_not_resolved():
    from skills_registry.bundled import load_bundled_skill

    assert load_bundled_skill("../../other") is None


def test_generated_skill_is_in_registry():
    from skills_registry.packs import load_packs
    from skills_registry.project import load_project_config
    from skills_registry.resolver import resolve

    resolution = resolve(load_packs(ROOT / "skills"), load_project_config(ROOT))
    assert NAME in {skill.name for skill in resolution.selected}


def test_common_prompt_includes_bundled_skill(tmp_path):
    from core.llm_optimization import build_base_system_prompt
    from skills_registry.bundled import load_bundled_skill

    body = load_bundled_skill(NAME)[1]
    for hint in (False, True):
        prompt = build_base_system_prompt(tmp_path, tool_use_hint=hint)
        assert body in prompt
        assert prompt == build_base_system_prompt(tmp_path, tool_use_hint=hint)


def test_missing_bundled_resource_does_not_break_prompt(tmp_path, monkeypatch):
    from core.llm_optimization import build_base_system_prompt
    from skills_registry import bundled

    monkeypatch.setattr(
        bundled, "__file__", str(tmp_path / "backend/skills_registry/bundled.py")
    )
    assert "working directory" in build_base_system_prompt(tmp_path)


def test_project_override_is_not_shadowed_by_system_policy(tmp_path):
    from core.llm_optimization import build_base_system_prompt
    from skills_registry.bundled import load_bundled_skill

    skill = tmp_path / ".agents" / "skills" / NAME / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text(
        f"---\nname: {NAME}\n---\nUse the installed local reader", encoding="utf-8"
    )
    prompt = build_base_system_prompt(tmp_path)
    assert load_bundled_skill(NAME)[1] not in prompt
    assert f"./.agents/skills/{NAME}/SKILL.md" in prompt
