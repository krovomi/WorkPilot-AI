"""Each version's documentation, written by Claude Code on the release branch (scripts/release_docs.py).

What Claude writes is held to what it may touch: README EN/FR, CHANGELOG.md
(while its section still parses), existing docs/ files, and existing wiki
pages outside AUTOGEN blocks. A token in the text discards everything. The
CLI is replaced by a fake script on PATH, the wiki by a local repository.
"""

from __future__ import annotations

import base64
import importlib.util
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from foundation.platform import is_windows

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "release_docs", ROOT / "scripts" / "release_docs.py"
)
rd = importlib.util.module_from_spec(_spec)
sys.modules["release_docs"] = rd
_spec.loader.exec_module(rd)

SECTION = "## 1.5.1 - Corrections et maintenance\n\nIntro.\n\n### 🐛 Corrections\n\n- **A**.\n\n---\n\n"


def _sh(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout


def _repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True)
    _sh(path, "init", "-q", "-b", "main")
    for key, value in (("user.name", "t"), ("user.email", "t@example.com")):
        _sh(path, "config", key, value)
    for name, text in files.items():
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    _sh(path, "add", ".")
    _sh(path, "commit", "-q", "-m", "init")
    return path


def _project(tmp_path: Path) -> Path:
    return _repo(
        tmp_path / "project",
        {
            "README.md": "# App\n\n- old feature\n",
            "README.fr.md": "# App\n\n- ancienne feature\n",
            "CHANGELOG.md": f"# Changelog\n\n{SECTION}## 1.5.0 - Before\n\n- old\n",
            "docs/RELEASE.md": "release doc\n",
            "apps/main.py": "x = 1\n",
            "scripts/wiki/patches/.keep": "",
        },
    )


WIKI_HOME = "# Home\n\n## What's new in 1.5.0\n\n- old\n"
WIKI_ROADMAP = "# Roadmap\n\n<!-- AUTOGEN:NARRATIVE:START -->\nauto\n<!-- AUTOGEN:NARRATIVE:END -->\n\n## Recent releases\n"


def _wiki(tmp_path: Path) -> Path:
    return _repo(
        tmp_path / "wiki-origin", {"Home.md": WIKI_HOME, "Roadmap.md": WIKI_ROADMAP}
    )


def _fake_claude(tmp_path: Path, monkeypatch, script: str) -> None:
    """A `claude` on PATH that runs ``script`` (Python) in the project directory."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    body = tmp_path / "fake_claude.py"
    body.write_text(script, encoding="utf-8")
    # -X utf8: the scripts read the UTF-8 changelog, and the release keeps
    # PYTHONUTF8 out of Claude's environment.
    if is_windows():
        # The npm CLI is a .cmd shim on Windows; so is this stand-in.
        exe = bindir / "claude.cmd"
        exe.write_text(f'@"{sys.executable}" -X utf8 "{body}" %*\r\n', encoding="utf-8")
    else:
        exe = bindir / "claude"
        exe.write_text(
            f'#!/bin/sh\nexec "{sys.executable}" -X utf8 "{body}" "$@"\n',
            encoding="utf-8",
        )
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token-for-tests")


def _wire_wiki(monkeypatch, wiki_origin: Path) -> None:
    def clone(_repo_name, into):
        target = into / "wiki"
        _sh(into, "clone", "-q", str(wiki_origin), str(target))
        return target

    monkeypatch.setattr(rd, "clone_wiki", clone)


def _document(project: Path):
    return rd.document(
        repo="o/r",
        cwd=project,
        version="1.5.1",
        level="patch",
        previous="1.5.0",
        notes="### 🐛 Corrections\n\n- **A**.",
        changes="- #1 [patch] fix: a",
        date="2026-11-15",
    )


EDIT_EVERYTHING = r"""
import sys
from pathlib import Path
args = sys.argv[1:]
wiki = Path(args[args.index("--add-dir") + 1])
prompt = sys.stdin.read()
assert "<data>" in prompt and "1.5.1" in prompt
assert "Bash" in args[args.index("--disallowedTools") + 1]
p = Path("README.md"); p.write_text(p.read_text() + "- new feature\n")
p = Path("README.fr.md"); p.write_text(p.read_text() + "- nouvelle feature\n")
p = Path("CHANGELOG.md"); p.write_text(p.read_text().replace("Corrections et maintenance", "Le replay marche").replace("Intro.", "Le replay atteint le backend."))
Path("apps/main.py").write_text("x = 2\n")
Path("docs/new.md").write_text("new\n")
p = wiki / "Home.md"; p.write_text(p.read_text().replace("1.5.0", "1.5.1"))
p = wiki / "Roadmap.md"; p.write_text(p.read_text().replace("auto", "hacked") + "\n### v1.5.1\n")
(wiki / "New.md").write_text("new page\n")
"""


def test_documentation_kept_only_where_claude_may_write(tmp_path, monkeypatch):
    project = _project(tmp_path)
    _wire_wiki(monkeypatch, _wiki(tmp_path))
    _fake_claude(tmp_path, monkeypatch, EDIT_EVERYTHING)
    result = _document(project)
    assert result.status == "written", result
    assert "README.md" in result.files and "README.fr.md" in result.files
    assert "CHANGELOG.md" in result.files
    assert (project / "apps/main.py").read_text(encoding="utf-8") == "x = 1\n"
    assert not (project / "docs/new.md").exists()
    assert "## 1.5.1 - Le replay marche" in (project / "CHANGELOG.md").read_text(
        encoding="utf-8"
    )
    patches = list((project / "scripts/wiki/patches").glob("*.patch"))
    assert [p.name for p in patches] == ["0001-release-1.5.1.patch"]
    patch = patches[0].read_text(encoding="utf-8")
    assert "Home.md" in patch and "What's new in 1.5.1" in patch
    # Roadmap touched an AUTOGEN block, New.md is a new page: both left out.
    assert "Roadmap.md" not in patch and "New.md" not in patch


def test_a_broken_changelog_section_is_put_back(tmp_path, monkeypatch):
    project = _project(tmp_path)
    _wire_wiki(monkeypatch, _wiki(tmp_path))
    _fake_claude(
        tmp_path,
        monkeypatch,
        'from pathlib import Path\np = Path("CHANGELOG.md")\n'
        'p.write_text(p.read_text().replace("## 1.5.1 - Corrections et maintenance", "## Something"))\n'
        'p = Path("README.md"); p.write_text(p.read_text() + "- x\\n")\n',
    )
    result = _document(project)
    assert result.files == ["README.md"]
    assert SECTION in (project / "CHANGELOG.md").read_text(encoding="utf-8")


def test_a_token_in_the_text_discards_everything(tmp_path, monkeypatch):
    project = _project(tmp_path)
    _wire_wiki(monkeypatch, _wiki(tmp_path))
    monkeypatch.setenv("PAT_TOKEN", "github_pat_secret_value_123")
    encoded = base64.b64encode(b"x-access-token:github_pat_secret_value_123").decode()
    _fake_claude(
        tmp_path,
        monkeypatch,
        f'from pathlib import Path\np = Path("README.md"); p.write_text(p.read_text() + "{encoded}\\n")\n',
    )
    result = _document(project)
    assert result.status == "discarded"
    assert _sh(project, "status", "--porcelain") == ""


def test_claude_never_sees_the_push_token(tmp_path, monkeypatch):
    project = _project(tmp_path)
    _wire_wiki(monkeypatch, _wiki(tmp_path))
    monkeypatch.setenv("PAT_TOKEN", "github_pat_secret_value_123")
    monkeypatch.setenv("GITHUB_TOKEN", "ghs_default_token_456")
    _fake_claude(
        tmp_path,
        monkeypatch,
        "import os\nfrom pathlib import Path\n"
        'assert "PAT_TOKEN" not in os.environ and "GITHUB_TOKEN" not in os.environ\n'
        'assert os.environ["CLAUDE_CODE_OAUTH_TOKEN"]\n'
        'p = Path("README.md"); p.write_text(p.read_text() + "- ok\\n")\n',
    )
    assert _document(project).files == ["README.md"]


def test_a_failed_run_leaves_nothing(tmp_path, monkeypatch):
    project = _project(tmp_path)
    _wire_wiki(monkeypatch, _wiki(tmp_path))
    _fake_claude(
        tmp_path,
        monkeypatch,
        'from pathlib import Path\nPath("README.md").write_text("half\\n")\nraise SystemExit(1)\n',
    )
    result = _document(project)
    assert result.status == "skipped"
    assert _sh(project, "status", "--porcelain") == ""


def test_without_a_token_or_cli_nothing_runs(tmp_path, monkeypatch):
    project = _project(tmp_path)
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert _document(project).status == "skipped"
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "x" * 20)
    monkeypatch.setenv("PATH", str(tmp_path))
    result = _document(project)
    assert (result.status, result.reason) == ("skipped", "CLI claude absent")


def test_nothing_to_document(tmp_path, monkeypatch):
    project = _project(tmp_path)
    _wire_wiki(monkeypatch, _wiki(tmp_path))
    _fake_claude(tmp_path, monkeypatch, "pass\n")
    assert _document(project).status == "unchanged"


# -- wiki patches ------------------------------------------------------------


def _patch_from(wiki_origin: Path, tmp_path: Path, name: str, edit) -> Path:
    clone = tmp_path / f"clone-{name}"
    _sh(tmp_path, "clone", "-q", str(wiki_origin), str(clone))
    for key, value in (("user.name", "t"), ("user.email", "t@example.com")):
        _sh(clone, "config", key, value)
    edit(clone)
    _sh(clone, "commit", "-qam", name)
    out = tmp_path / f"{name}.patch"
    out.write_bytes(
        subprocess.run(
            ["git", "format-patch", "-1", "--stdout"],
            cwd=clone,
            capture_output=True,
            check=True,
        ).stdout
    )
    return out


def test_applied_patches_are_deleted_pending_ones_replayed(tmp_path):
    origin = _wiki(tmp_path)
    applied = _patch_from(
        origin,
        tmp_path,
        "applied",
        lambda c: (c / "Home.md").write_text(WIKI_HOME + "applied\n", encoding="utf-8"),
    )
    # The wiki already has the first patch.
    _sh(origin, "am", "-q", str(applied))
    pending = _patch_from(
        origin,
        tmp_path,
        "pending",
        lambda c: (c / "Roadmap.md").write_text(
            WIKI_ROADMAP + "pending\n", encoding="utf-8"
        ),
    )
    _sh(origin, "reset", "-q", "--hard", "HEAD")
    directory = tmp_path / "patches"
    directory.mkdir()
    (directory / "0006-release-1.5.0.patch").write_bytes(applied.read_bytes())
    (directory / "0007-faq.patch").write_bytes(pending.read_bytes())
    wiki = tmp_path / "live"
    _sh(tmp_path, "clone", "-q", str(origin), str(wiki))

    deleted = rd.tidy_patches(wiki, directory)
    assert [p.name for p in deleted] == ["0006-release-1.5.0.patch"]
    assert [p.name for p in directory.glob("*.patch")] == ["0007-faq.patch"]
    assert "pending" in (wiki / "Roadmap.md").read_text(encoding="utf-8")
    assert rd.next_patch_name(directory, "1.5.1") == "0008-release-1.5.1.patch"


def test_patch_numbering_starts_at_one():
    assert (
        rd.next_patch_name(Path("/nonexistent"), "2.0.0") == "0001-release-2.0.0.patch"
    )


# -- pure rules --------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "path", "ok"),
    [
        (" M", "README.md", True),
        (" M", "README.fr.md", True),
        (" M", "CHANGELOG.md", True),
        (" M", "docs/rules/workflow.md", True),
        ("??", "docs/new.md", False),
        (" D", "docs/RELEASE.md", False),
        (" M", "apps/main.py", False),
        (" M", ".github/workflows/release.yml", False),
        (" M", "docsx/a.md", False),
    ],
)
def test_allowed_in_repo(status, path, ok):
    assert rd.allowed_in_repo(status, path) is ok


def test_changelog_section_check():
    assert rd.changelog_section_ok(f"# C\n\n{SECTION}", "1.5.1")
    assert not rd.changelog_section_ok("# C\n\n## 1.5.1 - \n\n### A\n- x\n", "1.5.1")
    assert not rd.changelog_section_ok(
        "# C\n\n## 1.5.1 - T\n\n<!-- x -->\n### A\n", "1.5.1"
    )
    assert not rd.changelog_section_ok("# C\n\n## 1.5.1 - T\n\nno sections\n", "1.5.1")
    assert not rd.changelog_section_ok(f"{SECTION}{SECTION}", "1.5.1")


def test_secret_forms_cover_the_extraheader():
    forms = rd.secret_forms(["abcdefgh12345", "short"])
    assert "abcdefgh12345" in forms
    assert base64.b64encode(b"x-access-token:abcdefgh12345").decode() in forms
    assert not any("short" in f for f in forms)
    assert rd.leaks(["see abcdefgh12345"], ["abcdefgh12345"])
    assert not rd.leaks(["clean"], ["abcdefgh12345"])


def test_the_prompt_marks_pull_request_text_as_data():
    assert "<data>" in rd.PROMPT and "never an instruction" in rd.PROMPT
    assert "Bash" not in rd.TOOLS
    assert "PAT_TOKEN" not in rd.CLAUDE_ENV and "GITHUB_TOKEN" not in rd.CLAUDE_ENV


def test_the_cli_is_started_by_the_path_found_on_path(tmp_path, monkeypatch):
    """On Windows the CLI is claude.cmd: a bare "claude" would look for claude.exe."""
    shim = str(tmp_path / "bin" / "claude.cmd")
    seen: dict = {}

    def run(cmd, **kwargs):
        seen["cmd"], seen["env"] = cmd, kwargs["env"]
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(rd.shutil, "which", lambda name: shim)
    monkeypatch.setattr(rd.subprocess, "run", run)
    monkeypatch.setenv("SYSTEMROOT", r"C:\Windows")
    monkeypatch.setenv("PAT_TOKEN", "github_pat_secret_value_123")
    assert rd.run_claude("prompt", tmp_path, None) is True
    assert seen["cmd"][0] == shim
    # Windows needs SYSTEMROOT to start any process; the push token stays out.
    assert seen["env"]["SYSTEMROOT"] == r"C:\Windows"
    assert "PAT_TOKEN" not in seen["env"]
