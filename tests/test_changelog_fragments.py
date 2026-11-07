"""Unreleased changes are fragments of changelog.d/, folded in at release."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "changelog", ROOT / "scripts" / "changelog.py"
)
changelog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(changelog)


def _fragment(directory: Path, name: str, section: str, body: str) -> Path:
    path = directory / name
    path.write_text(f"---\nsection: {section}\n---\n\n{body}\n", encoding="utf-8")
    return path


def test_every_fragment_of_the_repo_is_valid():
    for path in changelog.fragment_files():
        changelog.read_fragment(path)


def test_the_changelog_has_no_unreleased_section():
    # A PR that writes here again brings back the conflicts the fragments remove.
    text = changelog.CHANGELOG.read_text(encoding="utf-8")
    assert not re.search(r"(?m)^## \[?Unreleased", text)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("- **x**\n", "frontmatter"),
        ("---\nsection: Fixes\n---\n\n- **x**\n", "section must be"),
        ("---\nsection: 🐛 Corrections\n---\n\nJust prose.\n", "list items"),
        ("---\nsection: 🐛 Corrections\n---\n\n- x\n\n### Other\n", "no heading"),
    ],
)
def test_an_invalid_fragment_is_refused(tmp_path, text, message):
    path = tmp_path / "bad.md"
    path.write_text(text, encoding="utf-8")
    with pytest.raises(changelog.FragmentError, match=message):
        changelog.read_fragment(path)


def test_release_folds_the_fragments_in_section_order(tmp_path):
    frags = tmp_path / "changelog.d"
    frags.mkdir()
    (frags / "README.md").write_text("not a fragment", encoding="utf-8")
    _fragment(frags, "b-fix.md", "🐛 Corrections", "- **Second fix**")
    _fragment(frags, "a-fix.md", "🐛 Corrections", "- **First fix**")
    _fragment(frags, "feature.md", "✨ Nouveautés", "- **A feature**")
    log = tmp_path / "CHANGELOG.md"
    log.write_text(
        "# Changelog\n\nIntro.\n\n## 1.0.0 - Old\n\nOld notes.\n", encoding="utf-8"
    )

    changelog.release("1.1.0", "New", frags, log)

    text = log.read_text(encoding="utf-8")
    assert text.startswith("# Changelog\n\nIntro.\n\n## 1.1.0 - New\n")
    assert text.index("### ✨ Nouveautés") < text.index("### 🐛 Corrections")
    assert (
        text.index("First fix")
        < text.index("Second fix")
        < text.index("## 1.0.0 - Old")
    )
    assert [p.name for p in frags.iterdir()] == ["README.md"]


def test_release_refuses_twice_the_same_version_or_nothing_to_release(tmp_path):
    frags = tmp_path / "changelog.d"
    frags.mkdir()
    log = tmp_path / "CHANGELOG.md"
    log.write_text("# Changelog\n\n## 1.0.0 - Old\n", encoding="utf-8")
    with pytest.raises(changelog.FragmentError, match="nothing to release"):
        changelog.release("1.1.0", "New", frags, log)
    _fragment(frags, "x.md", "🐛 Corrections", "- **x**")
    with pytest.raises(changelog.FragmentError, match="already has"):
        changelog.release("1.0.0", "Again", frags, log)
    with pytest.raises(changelog.FragmentError, match="not a version"):
        changelog.release("v1.1", "Bad", frags, log)
    assert (frags / "x.md").exists()


def test_the_release_workflow_still_finds_a_folded_section(tmp_path):
    # prepare-release.yml and release.yml extract "## X.Y.Z - Title" up to "---".
    frags = tmp_path / "changelog.d"
    frags.mkdir()
    _fragment(frags, "x.md", "🐛 Corrections", "- **x**")
    log = tmp_path / "CHANGELOG.md"
    log.write_text("# Changelog\n\n## 1.0.0 - Old\n", encoding="utf-8")
    changelog.release("1.1.0", "New", frags, log)
    text = log.read_text(encoding="utf-8")
    section = text.split("## 1.1.0 - New\n", 1)[1].split("\n---\n", 1)[0]
    assert "### 🐛 Corrections\n\n- **x**" in section
