"""What the agents are told about a WinDev project, per role.

docs/architecture/windev.md (« Consignes des agents »): edit only code blocks,
never the editor's values or a binary; a native project is blocked, not
guessed at; the skills are staged next to the spec and named by path.
"""

from __future__ import annotations

from pathlib import Path

from prompts_pkg.prompts import platform_section
from windev import windev_section
from windev.skills import SKILLS, STAGE_DIR, stage_skills


def test_a_project_that_is_not_windev_gets_nothing(tmp_path: Path):
    assert windev_section(tmp_path) == ""
    assert windev_section(None) == ""
    assert platform_section(tmp_path) == ""


def test_a_native_project_is_blocked_rather_than_guessed(native_project: Path):
    section = windev_section(native_project, role="coder")
    assert "native binary format" in section
    assert "blocked" in section
    assert "code : |1+" not in section


def test_each_role_gets_the_edit_rules_and_its_own(text_project: Path):
    planner = windev_section(text_project, role="planner")
    coder = windev_section(text_project, role="coder")
    qa = windev_section(text_project, role="qa")
    for section in (planner, coder, qa):
        assert "## WinDev project" in section
        assert "internal_properties" in section
        assert "Never create an element file" in section
    assert "À faire dans l'éditeur WinDev :" in planner
    assert "SI … FIN" in coder
    assert "integrity gate" in qa
    assert "never as passed" in qa
    # The binary analysis is counted apart from the readable elements.
    assert "3 element file(s) are in the text format" in coder
    assert windev_section(text_project, role="unknown") == coder


def test_the_skills_are_staged_next_to_the_spec_and_named(text_project: Path):
    spec = text_project / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    section = windev_section(text_project, spec, role="coder")
    for name in SKILLS:
        staged = spec / STAGE_DIR / name / "SKILL.md"
        assert staged.is_file()
        assert f"`./.workpilot/specs/001-x/windev/{name}/SKILL.md`" in section
    assert "windev" in platform_section(text_project, spec, role="qa").lower()


def test_staging_is_idempotent_and_keeps_an_existing_copy(tmp_path: Path):
    first = stage_skills(tmp_path)
    assert [p.parent.name for p in first] == list(SKILLS)
    first[0].write_text("local", encoding="utf-8")
    assert stage_skills(tmp_path) == first
    assert first[0].read_text(encoding="utf-8") == "local"
    assert stage_skills(tmp_path / "missing") == []
    assert stage_skills(None) == []
