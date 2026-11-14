"""The Brain runner, as the CLI and the desktop app start it.

Every action runs for real against a brain in a temporary folder (a git
repository the runner creates), with a temporary home so `bridge` and
`connect` only ever touch that home's agent files. `serve` (an MCP server on
stdio) and `watch` (an endless loop) run in-process.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "brain_runner.py"
MARKER = "__BRAIN_RESULT__:"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    folder = tmp_path / "home"
    folder.mkdir()
    return folder


@pytest.fixture
def brain_dir(tmp_path: Path) -> Path:
    return tmp_path / "brain"


def _run(home: Path, brain_dir: Path, *args: str) -> tuple[int, dict]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")} | {
        "HOME": str(home),
        "USERPROFILE": str(home),
        # The home the agents' files are looked up in (conftest sets its own).
        "WORKPILOT_BRAIN_HOME": str(home),
    }
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--brain-dir", str(brain_dir), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=180,
        check=False,
    )
    [line] = [ln for ln in done.stdout.splitlines() if ln.startswith(MARKER)]
    return done.returncode, json.loads(line[len(MARKER) :])


def test_a_brain_is_created_remembers_and_recalls(home, brain_dir) -> None:
    code, out = _run(home, brain_dir)
    assert code == 0 and out["exists"] is False and out["git"] is False

    code, out = _run(home, brain_dir, "--action", "init")
    assert code == 0 and out["seeded"] == ["skills/graph-first-recall/SKILL.md"]
    assert (brain_dir / ".git").is_dir()
    assert out["sync"]["skipped"] == "no-remote"

    code, out = _run(
        home,
        brain_dir,
        "--action",
        "remember",
        "--text",
        "Always answer in French",
        "--agent",
        "codex",
    )
    assert code == 0 and out["outcome"] == "created"
    rel = out["rel"]
    assert rel.startswith("instructions/always-answer-in-french")

    code, out = _run(home, brain_dir, "--action", "recall", "--query", "French")
    assert code == 0
    assert [h["source_file"] for h in out["hits"]] == [rel]

    code, out = _run(home, brain_dir, "--action", "read", "--path", rel[:-3])
    assert code == 0 and "Always answer in French" in out["body"]

    code, out = _run(home, brain_dir, "--action", "status")
    assert out["exists"] is True and out["notes"]["instructions"] == 1


def test_an_instruction_is_promoted_or_retired(home, brain_dir) -> None:
    _run(home, brain_dir, "--action", "init")
    rel = _run(home, brain_dir, "--action", "remember", "--text", "Use pnpm")[1]["rel"]
    code, out = _run(home, brain_dir, "--action", "promote", "--path", rel)
    assert code == 0 and out["status"] == "active"
    code, out = _run(home, brain_dir, "--action", "reject", "--path", rel)
    assert code == 0 and out["status"] == "retired"
    assert _run(home, brain_dir, "--action", "proposals")[1] == {
        "success": True,
        "proposals": [],
    }


@pytest.mark.parametrize("action", ["sync", "pull", "push"])
def test_sync_and_its_aliases_without_a_remote(home, brain_dir, action) -> None:
    _run(home, brain_dir, "--action", "init")
    (brain_dir / "knowledge").mkdir(exist_ok=True)
    (brain_dir / "knowledge" / "edit.md").write_text("# Edited\n", encoding="utf-8")
    code, out = _run(home, brain_dir, "--action", action, "--message", "by hand")
    assert code == 0
    assert out["committed"] is True and out["skipped"] == "no-remote"
    log = subprocess.run(
        ["git", "log", "-1", "--format=%s"],
        cwd=brain_dir,
        capture_output=True,
        text=True,
        check=True,
    )
    assert log.stdout.strip() == "by hand"


def test_agent_memories_are_found_ingested_and_bridged(home, brain_dir, tmp_path):
    project = tmp_path / "shop"
    project.mkdir()
    (project / "CLAUDE.md").write_text(
        "# Rules\n\n- Always run the tests before pushing.\n", encoding="utf-8"
    )
    code, out = _run(
        home, brain_dir, "--action", "discover", "--project-dir", str(project)
    )
    assert code == 0
    existing = [m for m in out["memories"] if m["exists"]]
    assert [(m["agent"], m["scope"]) for m in existing] == [("claude-code", "project")]
    assert existing[0]["path"] == str(project.resolve() / "CLAUDE.md")

    code, out = _run(
        home,
        brain_dir,
        "--action",
        "ingest",
        "--project-dir",
        str(project),
        "--agent",
        "claude-code",
    )
    assert code == 0 and brain_dir.joinpath(".git").is_dir()
    assert out["created"] >= 1

    code, out = _run(home, brain_dir, "--action", "bridge", "--agent", "codex")
    assert code == 0
    [preview] = out["bridges"]
    assert preview["action"] == "preview"
    assert not (home / ".codex" / "AGENTS.md").exists()

    code, out = _run(
        home, brain_dir, "--action", "bridge", "--agent", "codex", "--apply"
    )
    assert code == 0
    text = (home / ".codex" / "AGENTS.md").read_text(encoding="utf-8")
    assert "workpilot-brain:start" in text and str(brain_dir) in text

    code, out = _run(home, brain_dir, "--action", "bridge")
    assert code == 0 and len(out["bridges"]) > 1


def test_connect_previews_the_mcp_entry_of_an_agent(home, brain_dir) -> None:
    _run(home, brain_dir, "--action", "init")
    code, out = _run(home, brain_dir, "--action", "connect", "--agent", "hermes")
    assert code == 0
    [entry] = out["connections"]
    assert entry["agent"] == "hermes" and entry["action"] == "preview"
    assert "workpilot-brain" in entry["snippet"]


def test_build_memory_from_before_the_vault_is_imported(home, brain_dir, tmp_path):
    project = tmp_path / "shop"
    legacy = project / ".workpilot" / "specs" / "003-auth" / "memory"
    legacy.mkdir(parents=True)
    (legacy / "gotchas.md").write_text(
        "- The auth tests need REDIS_URL set.\n", encoding="utf-8"
    )
    (project / ".workpilot" / "specs" / "004-empty" / "memory").mkdir(parents=True)
    code, out = _run(
        home, brain_dir, "--action", "import-legacy", "--project-dir", str(project)
    )
    assert code == 0
    assert len(out["specs"]) == 1


@pytest.mark.parametrize(
    ("args", "error"),
    [
        (["--action", "bridge"], "run --action init first"),
        (["--action", "connect"], "run --action init first"),
        (["--action", "promote"], "--path is required"),
        (["--action", "read", "--path", "../outside"], "stays inside it"),
    ],
)
def test_refusals_come_back_as_an_error(home, brain_dir, args, error) -> None:
    code, out = _run(home, brain_dir, *args)
    assert code == 1 and out["success"] is False
    assert error in out["error"]


# --- in-process: serve, watch, and an action the parser cannot pass ---------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("brain_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_serve_hands_the_brain_to_the_mcp_server(runner, monkeypatch, brain_dir):
    import brain.mcp_server

    served = []
    monkeypatch.setattr(brain.mcp_server, "serve", lambda b: served.append(b.root))
    assert runner.main(["--action", "serve", "--brain-dir", str(brain_dir)]) == 0
    assert served == [brain_dir]


def test_watch_prints_only_the_syncs_that_did_something(
    runner, monkeypatch, capsys, brain_dir
) -> None:
    from brain.sync import SyncResult

    results = iter(
        [
            SyncResult(committed=True),
            SyncResult(),
            SyncResult(error="network down"),
        ]
    )
    naps = []

    def sync(self, message):
        try:
            return next(results)
        except StopIteration:
            raise KeyboardInterrupt from None

    monkeypatch.setattr(runner.Brain, "sync", sync)
    monkeypatch.setattr(runner.time, "sleep", naps.append)
    code = runner.main(
        ["--action", "watch", "--brain-dir", str(brain_dir), "--interval", "1"]
    )
    assert code == 0
    captured = capsys.readouterr()
    printed = [json.loads(ln[len(MARKER) :]) for ln in captured.out.splitlines()]
    assert [p["committed"] for p in printed] == [True, False]
    assert printed[1]["error"] == "network down"
    # Never more often than every five seconds.
    assert naps == [5.0, 5.0, 5.0]
    assert "Ctrl+C to stop" in captured.err


def test_an_unknown_action_is_refused(runner, brain_dir) -> None:
    args = argparse.Namespace(
        action="dance", brain_dir=str(brain_dir), project_dir=None, agent=None
    )
    with pytest.raises(ValueError, match="unknown action dance"):
        runner.run(args)
