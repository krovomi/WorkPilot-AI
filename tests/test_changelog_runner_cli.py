"""The changelog runner, run as the server's changelog job runs it.

A real clone with commits, a tag and a feature branch; the git readers and
the desktop's prompts are the real ones. Only the provider's one-shot
completion is a stand-in.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "changelog_runner.py"


def _git(cwd: Path, *args: str) -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="Ada",
        GIT_AUTHOR_EMAIL="ada@example.test",
        GIT_COMMITTER_NAME="Ada",
        GIT_COMMITTER_EMAIL="ada@example.test",
    )
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    root = tmp_path / "clone"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "commit.gpgsign", "false")
    for name, subject in (
        ("a.txt", "feat(cart): add a cart"),
        ("b.txt", "fix: totals"),
    ):
        (root / name).write_text(name, encoding="utf-8")
        _git(root, "add", name)
        _git(root, "commit", "-q", "-m", subject)
    _git(root, "branch", "same")
    _git(root, "checkout", "-q", "-b", "feature/pay")
    (root / "c.txt").write_text("c", encoding="utf-8")
    _git(root, "add", "c.txt")
    _git(root, "commit", "-q", "-m", "feat: pay by card")
    _git(root, "checkout", "-q", "main")
    return root


def _process(clone: Path, options: dict) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-path",
            str(clone),
            f"--options={json.dumps(options)}",
        ],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def _error(out: str) -> str:
    [line] = [x for x in out.splitlines() if x.startswith("CHANGELOG_ERROR:")]
    return line[len("CHANGELOG_ERROR:") :]


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"source_mode": "tasks"}, "Invalid options"),
        (
            {
                "source_mode": "git-history",
                "git_history": {"type": "since-date", "since_date": "2090-01-01"},
            },
            "No commits found for the specified range",
        ),
        (
            {
                "source_mode": "branch-diff",
                "branch_diff": {"base_branch": "main", "compare_branch": "same"},
            },
            "No commits found between the specified branches",
        ),
    ],
)
def test_a_request_with_nothing_to_tell_never_reaches_the_model(
    clone: Path, options: dict, message: str
) -> None:
    done = _process(clone, options)

    assert done.returncode == 1
    assert _error(done.stdout) == message


# --- With the model, in process -------------------------------------------------------


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("changelog_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def model(monkeypatch):
    import core.oneshot

    seen: dict = {"prompts": [], "answer": "", "failure": None, "project_dir": None}

    async def oneshot(prompt, *, project_dir=None, on_error=None, **_options):
        seen["prompts"].append(prompt)
        seen["project_dir"] = project_dir
        if seen["failure"]:
            on_error(seen["failure"])
            return ""
        return seen["answer"]

    monkeypatch.setattr(core.oneshot, "oneshot_completion", oneshot)
    return seen


def _lines(out: str, prefix: str) -> list:
    return [
        json.loads(x[len(prefix) :]) for x in out.splitlines() if x.startswith(prefix)
    ]


def test_the_recent_history_becomes_the_changelog(runner, model, clone, capsys) -> None:
    model["answer"] = "Here it is:\n## [1.2.0] - 2026-11-14\n### Added\n- A cart"
    options = {
        "source_mode": "git-history",
        "git_history": {"type": "recent", "count": 5},
        "version": "1.2.0",
        "date": "2026-11-14",
    }

    code = runner.main(
        ["--project-path", str(clone), f"--options={json.dumps(options)}"]
    )

    out = capsys.readouterr().out
    assert code == 0, out
    [result] = _lines(out, "CHANGELOG_RESULT:")
    assert result["changelog"] == "## [1.2.0] - 2026-11-14\n### Added\n- A cart"
    assert result["itemsIncluded"] == 2
    assert result["sourceMode"] == "git-history"
    assert "add a cart" in model["prompts"][0]
    assert "pay by card" not in model["prompts"][0]
    assert model["project_dir"] == str(clone.resolve())
    stages = [e["stage"] for e in _lines(out, "CHANGELOG_EVENT:")]
    assert stages == ["loading_commits", "generating", "formatting", "complete"]


def test_a_branch_diff_tells_only_what_the_branch_adds(
    runner, model, clone, capsys
) -> None:
    model["answer"] = "## [2.0.0]\n- Pay by card"
    options = {
        "source_mode": "branch-diff",
        "branch_diff": {"base_branch": "main", "compare_branch": "feature/pay"},
    }

    assert (
        runner.main(["--project-path", str(clone), f"--options={json.dumps(options)}"])
        == 0
    )

    [result] = _lines(capsys.readouterr().out, "CHANGELOG_RESULT:")
    assert result["itemsIncluded"] == 1
    assert "pay by card" in model["prompts"][0]
    assert "add a cart" not in model["prompts"][0]


def test_a_provider_failure_is_told_with_its_reason(
    runner, model, clone, capsys
) -> None:
    model["failure"] = {"message": "The provider refused the key.", "code": "auth"}
    options = {"source_mode": "git-history", "git_history": {"type": "recent"}}

    assert (
        runner.main(["--project-path", str(clone), f"--options={json.dumps(options)}"])
        == 1
    )

    assert _error(capsys.readouterr().out) == "The provider refused the key."


def test_an_empty_answer_is_no_changelog(runner, model, clone, capsys) -> None:
    options = {"source_mode": "git-history", "git_history": {"type": "recent"}}

    assert (
        runner.main(["--project-path", str(clone), f"--options={json.dumps(options)}"])
        == 1
    )

    assert _error(capsys.readouterr().out) == "The model returned no changelog"


def test_options_built_without_their_checks_still_need_commits(runner, clone) -> None:
    from changelog_generator.options import ChangelogOptions

    unchecked = ChangelogOptions.model_construct(
        source_mode="git-history", git_history=None, branch_diff=None
    )

    with pytest.raises(runner.ChangelogError, match="Say which commits"):
        runner.build_prompt(clone, unchecked)
