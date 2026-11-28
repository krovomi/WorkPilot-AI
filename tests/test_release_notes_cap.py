"""A release's notes stay under GitHub's size limit (scripts/release_notes_cap.py)."""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import release_notes_cap as cap_module  # noqa: E402

GITHUB_LIMIT = 125_000


def test_a_short_section_is_left_as_it_is():
    text = "Intro.\n\n### ✨ Nouveautés\n\n- **Une chose** (#1).\n"
    assert cap_module.cap(text, "1.6.0", "o/r") == text


def test_a_long_section_keeps_whole_entries_and_links_to_the_changelog():
    entry = "- **Entrée** : " + "x" * 300 + "\n  suite de l'entrée.\n"
    text = "Intro.\n\n### ✨ Nouveautés\n\n" + entry * 1000
    capped = cap_module.cap(text, "1.6.0", "o/r")
    assert len(capped) <= cap_module.BUDGET < GITHUB_LIMIT
    body, link = capped.rsplit("\n\n_La suite", 1)
    assert body.endswith("suite de l'entrée.")
    assert body.count("- **Entrée**") == body.count("suite de l'entrée.")
    assert "https://github.com/o/r/blob/main/CHANGELOG.md" in link


def test_the_cap_runs_on_the_notes_before_the_release_is_created(tmp_path: Path):
    workflow = yaml.safe_load(
        (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    )
    steps = workflow["jobs"]["create-release"]["steps"]
    extract = next(s for s in steps if s.get("id") == "changelog")
    run = extract["run"]
    assert (
        run.index("> changelog-body.md")
        < run.index("release_notes_cap.py changelog-body.md")
        < run.index("cat changelog-body.md")
    )

    notes = tmp_path / "changelog-body.md"
    notes.write_text("- **Entrée**\n" * 20_000, encoding="utf-8")
    assert cap_module.main([str(notes), "1.6.0", "o/r"]) == 0
    assert len(notes.read_text(encoding="utf-8")) <= cap_module.BUDGET
