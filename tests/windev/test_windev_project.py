"""Finding a WinDev-family project and reading what it is made of.

docs/architecture/windev.md: the product comes from what the files show, the
format from the project file, and a native project is reported as unreadable.
"""

from __future__ import annotations

import json
from pathlib import Path

from project.stack import (
    detect_project_stack,
    detect_project_type,
    windev_project,
)
from skills_registry.bundled import BUNDLED_SKILLS
from subagents.languages import overlays_for
from windev.project import detect_project, find_project_files

from tests.windev.samples import NATIVE, WINDOW, project_file

REPO = Path(__file__).resolve().parents[2]


def test_a_text_project_is_found_with_its_version_and_formats(text_project: Path):
    project = detect_project(text_project)
    assert project is not None
    assert project.name == "Gestion"
    assert project.project_format == "text"
    assert project.major_version == 28
    assert project.products == ["windev"]
    assert project.configurations == ["Exécutable Windows 64 bits"]
    # .wdp, .wdg and .wdw are text; the analysis stays binary.
    assert project.elements == {"text": 3, "native": 1}
    assert project.readable
    assert not project.fully_text
    assert project.as_dict()["readable"] is True


def test_a_native_project_is_found_but_unreadable(native_project: Path):
    project = detect_project(native_project)
    assert project is not None
    assert project.project_format == "native"
    assert project.major_version is None
    assert project.products == ["windev"]
    assert not project.readable


def test_the_product_comes_from_pages_and_configurations(tmp_path: Path):
    (tmp_path / "Appli.wdp").write_text(
        project_file(("Application Android", "Exécutable Windows 64 bits")),
        encoding="utf-8",
    )
    assert detect_project(tmp_path).products == ["windev", "windev-mobile"]

    (tmp_path / "Appli.wdp").write_text(
        project_file(("Application iOS",)), encoding="utf-8"
    )
    assert detect_project(tmp_path).products == ["windev-mobile"]

    (tmp_path / "PAGE_Accueil.wwh").write_text(WINDOW, encoding="utf-8")
    (tmp_path / "Appli.wdp").write_text(project_file(("Site",)), encoding="utf-8")
    assert detect_project(tmp_path).products == ["webdev"]


def test_the_project_file_is_looked_for_two_levels_down_outside_editor_folders(
    tmp_path: Path,
):
    assert detect_project(tmp_path) is None
    assert detect_project(None) is None
    (tmp_path / "Sauvegarde").mkdir()
    (tmp_path / "Sauvegarde" / "Old.wdp").write_bytes(NATIVE)
    (tmp_path / "a" / "b" / "c").mkdir(parents=True)
    (tmp_path / "a" / "b" / "c" / "Deep.wdp").write_bytes(NATIVE)
    assert find_project_files(tmp_path) == []
    (tmp_path / "a" / "b" / "Gestion.wdp").write_bytes(NATIVE)
    (tmp_path / "a" / "Top.wdp").write_bytes(NATIVE)
    assert [p.name for p in find_project_files(tmp_path)] == ["Top.wdp", "Gestion.wdp"]
    assert detect_project(tmp_path).root == tmp_path / "a"


def test_the_stack_reports_wlangage_and_the_windev_type(
    text_project: Path, tmp_path_factory
):
    stack = detect_project_stack(text_project)
    assert "wlangage" in stack["languages"]
    assert "windev" in stack["frameworks"]
    assert detect_project_type(text_project) == "windev"
    assert windev_project(text_project).name == "Gestion"
    empty = tmp_path_factory.mktemp("empty")
    assert "wlangage" not in detect_project_stack(empty)["languages"]
    assert windev_project(empty) is None


def test_the_test_runner_overlay_gives_no_command():
    (overlay,) = overlays_for(["wlangage"])
    assert overlay.language == "windev"
    assert "not verified" in overlay.notes
    assert not getattr(overlay, "commands", None)


def test_the_windev_skills_ship_with_the_desktop_build():
    assert {"wlangage", "windev-text-format"} <= set(BUNDLED_SKILLS)
    package = json.loads(
        (REPO / "apps/frontend/package.json").read_text(encoding="utf-8")
    )
    targets = {entry.get("to") for entry in package["build"]["extraResources"]}
    for name in ("wlangage", "windev-text-format"):
        assert f"backend/skills_registry/bundled/{name}" in targets
        assert (REPO / "skills/windev" / name / "SKILL.md").is_file()
