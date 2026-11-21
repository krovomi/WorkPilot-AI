"""Note paths stay in the vault, links followed."""

from __future__ import annotations

from pathlib import Path

import pytest
from brain.notes import Note, inside, iter_notes, read_note, write_note


def _link(link: Path, target: Path, *, is_dir: bool = False) -> None:
    try:
        link.symlink_to(target, target_is_directory=is_dir)
    except OSError:
        pytest.skip("symbolic links are not available here")


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "vault"
    root.mkdir()
    write_note(root, Note(path=Path("notes/a.md"), meta={"title": "A"}, body="a"))
    (root / "notes" / "image.png").write_bytes(b"png")
    (root / "notes" / ".draft.md").write_text("draft", encoding="utf-8")
    return root


@pytest.fixture
def elsewhere(tmp_path: Path) -> Path:
    folder = tmp_path / "elsewhere"
    folder.mkdir()
    (folder / "b.md").write_text("---\ntitle: B\n---\n\nb\n", encoding="utf-8")
    return folder


def test_a_plain_note_path_is_kept(vault: Path) -> None:
    assert inside(vault, "notes/a.md") == vault / "notes" / "a.md"
    assert read_note(vault, "notes/a.md").body.strip() == "a"


def test_dot_dot_and_absolute_paths_are_refused(vault: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        inside(vault, "../outside.md")
    with pytest.raises(ValueError):
        inside(vault, tmp_path / "outside.md")


def test_a_linked_file_that_leaves_the_vault_is_refused(
    vault: Path, elsewhere: Path
) -> None:
    _link(vault / "notes" / "b.md", elsewhere / "b.md")

    with pytest.raises(ValueError):
        read_note(vault, "notes/b.md")
    assert Path("notes/b.md") not in list(iter_notes(vault))


def test_a_linked_folder_that_leaves_the_vault_is_not_written(
    vault: Path, elsewhere: Path
) -> None:
    _link(vault / "out", elsewhere, is_dir=True)

    with pytest.raises(ValueError):
        write_note(vault, Note(path=Path("out/c.md"), meta={}, body="c"))
    assert not (elsewhere / "c.md").exists()


def test_a_link_that_stays_in_the_vault_still_works(vault: Path) -> None:
    _link(vault / "notes" / "alias.md", vault / "notes" / "a.md")

    assert read_note(vault, "notes/alias.md").body.strip() == "a"
    assert Path("notes/alias.md") in list(iter_notes(vault))


def test_a_vault_reached_through_a_link_keeps_its_notes(
    vault: Path, tmp_path: Path
) -> None:
    alias = tmp_path / "vault-alias"
    _link(alias, vault, is_dir=True)

    assert read_note(alias, "notes/a.md").body.strip() == "a"
    assert list(iter_notes(alias)) == [Path("notes/a.md")]
