"""Hand-written wiki pages follow the release through `scripts/wiki/patches/`.

The generators only own the AUTOGEN blocks. Prose outside them (what's new,
the roadmap, the security page) lives as `git format-patch` files reviewed in
a PR, and the release sync applies them. Pinned here, against a real git
remote on disk:

* a patch is applied and the commit reaches the remote, even though nothing
  is left uncommitted in the working tree;
* replaying the folder is harmless: an applied patch is skipped;
* a patch that no longer applies is named and left out, the others still go
  through, and the wiki is not left in the middle of a `git am`.
"""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "wiki" / "sync_wiki.py"


@pytest.fixture(scope="module")
def sw():
    spec = importlib.util.spec_from_file_location("sync_wiki", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "init.defaultBranch=master", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def identify(repo: Path) -> None:
    git(repo, "config", "user.name", "Wiki Editor")
    git(repo, "config", "user.email", "editor@example.invalid")
    git(repo, "config", "commit.gpgsign", "false")


@pytest.fixture
def wiki(tmp_path: Path) -> Path:
    """A clone of a bare wiki remote holding Home.md and Roadmap.md."""
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "--bare", str(remote))
    seed = tmp_path / "seed"
    git(tmp_path, "clone", str(remote), str(seed))
    identify(seed)
    (seed / "Home.md").write_text("# Home\n\nWelcome.\n")
    (seed / "Roadmap.md").write_text("# Roadmap\n\nLater.\n")
    git(seed, "add", "-A")
    git(seed, "commit", "-m", "seed")
    git(seed, "push", "origin", "HEAD:master")

    clone = tmp_path / "wiki"
    git(tmp_path, "clone", str(remote), str(clone))
    identify(clone)
    return clone


def make_patch(wiki: Path, out: Path, name: str, page: str, text: str) -> Path:
    """Write `text` into `page` on a throwaway branch and format it as a patch."""
    git(wiki, "checkout", "-q", "-b", f"draft-{name}", "origin/master")
    (wiki / page).write_text(text)
    git(wiki, "commit", "-qam", f"docs(wiki): {name}")
    produced = git(wiki, "format-patch", "-1", "-o", str(out)).strip()
    git(wiki, "checkout", "-q", "master")
    target = out / f"{name}.patch"
    Path(produced).rename(target)
    return target


@pytest.fixture
def patches(tmp_path: Path) -> Path:
    folder = tmp_path / "patches"
    folder.mkdir()
    return folder


def remote_file(wiki: Path, page: str) -> str:
    git(wiki, "fetch", "-q", "origin")
    return git(wiki, "show", f"origin/master:{page}")


def test_a_patch_is_applied_and_pushed(sw, wiki, patches):
    make_patch(wiki, patches, "0001-home", "Home.md", "# Home\n\nWhat's new.\n")

    assert sw.step_patches(wiki, patches) == []
    assert not sw.has_changes(wiki)
    assert sw.is_ahead_of_remote(wiki)

    sw.commit_and_push(wiki, "unused: nothing to stage")

    assert remote_file(wiki, "Home.md") == "# Home\n\nWhat's new.\n"
    assert not sw.is_ahead_of_remote(wiki)
    assert "docs(wiki): 0001-home" in git(wiki, "log", "-1", "--format=%s")


def test_replaying_an_applied_patch_does_nothing(sw, wiki, patches, capsys):
    make_patch(wiki, patches, "0001-home", "Home.md", "# Home\n\nWhat's new.\n")
    sw.step_patches(wiki, patches)
    head = git(wiki, "rev-parse", "HEAD")

    assert sw.step_patches(wiki, patches) == []

    assert git(wiki, "rev-parse", "HEAD") == head
    assert "already applied: 0001-home.patch" in capsys.readouterr().out


def test_a_stale_patch_is_named_and_the_others_still_apply(sw, wiki, patches, capsys):
    make_patch(wiki, patches, "0001-home", "Home.md", "# Home\n\nWhat's new.\n")
    make_patch(wiki, patches, "0002-roadmap", "Roadmap.md", "# Roadmap\n\nSoon.\n")
    # Someone rewrote the line the first patch changes, on the wiki itself.
    (wiki / "Home.md").write_text("# Home\n\nRewritten on the wiki.\n")
    git(wiki, "commit", "-qam", "edited in the GitHub UI")

    failed = sw.step_patches(wiki, patches)

    assert failed == ["0001-home.patch"]
    out = capsys.readouterr().out
    assert "::error::Wiki patch 0001-home.patch" in out
    assert (wiki / "Roadmap.md").read_text() == "# Roadmap\n\nSoon.\n"
    assert (wiki / "Home.md").read_text() == "# Home\n\nRewritten on the wiki.\n"
    assert not (wiki / ".git" / "rebase-apply").exists()
    assert not sw.has_changes(wiki)


def test_an_empty_folder_is_a_no_op(sw, wiki, patches):
    assert sw.step_patches(wiki, patches) == []
    assert not sw.is_ahead_of_remote(wiki)


def test_the_full_release_sync_applies_patches(sw, monkeypatch):
    """`full` is what release.yml dispatches; patches must be part of it."""
    calls: list[str] = []
    monkeypatch.setattr(
        sw, "detect_wiki_url", lambda _repo: "https://example.invalid/x.wiki.git"
    )
    monkeypatch.setattr(sw, "clone_or_pull_wiki", lambda *_a, **_k: Path("/tmp/w"))
    monkeypatch.setattr(sw, "configure_git", lambda *_a, **_k: None)
    monkeypatch.setattr(
        sw, "step_patches", lambda *_a, **_k: calls.append("patches") or []
    )
    for step in ("inventories", "narrative", "translate"):
        monkeypatch.setattr(
            sw, f"step_{step}", lambda *_a, _s=step, **_k: calls.append(_s)
        )
    monkeypatch.setattr(sw, "has_changes", lambda _wiki: False)
    monkeypatch.setattr(sw, "is_ahead_of_remote", lambda _wiki: False)
    monkeypatch.setattr(sw.sys, "argv", ["sync_wiki.py", "--mode", "full"])

    assert sw.main() == 0
    assert calls[0] == "patches"
    assert set(calls) == {"patches", "inventories", "narrative", "translate"}


def test_the_shipped_patches_are_well_formed():
    folder = REPO_ROOT / "scripts" / "wiki" / "patches"
    shipped = sorted(folder.glob("*.patch"))
    assert shipped, "the 1.3.1 wiki content is expected in scripts/wiki/patches/"
    for patch in shipped:
        raw = patch.read_bytes()
        assert b"\r\n" not in raw, f"{patch.name} has CRLF line endings"
        assert raw.startswith(b"From "), f"{patch.name} is not git format-patch output"
