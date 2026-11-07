"""Who wrote each line of a task: the Agent Trace record (killer feature F3).

Git is the source of truth, so a CLI provider's commit is attributed like a
SDK one; the lines the person left uncommitted before a session are theirs;
a file changed without a Write/Edit is noted as produced by a command; the
summary follows a range that moved and does not guess one that changed; and
nothing here can fail a build.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from agent_trace import (
    SPEC_VERSION,
    TRACE_FILE,
    after_session,
    attribution_line,
    model_id_of,
    note_tool_write,
    read_records,
    record_session,
    session_start,
    summarize,
)

SCHEMA = json.loads(
    (Path(__file__).with_name("trace_record_schema.json")).read_text(encoding="utf-8")
)
MODEL = "anthropic/claude-sonnet-5-5"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _commit(repo: Path, message: str) -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "wt"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "t@example.test")
    _git(root, "config", "user.name", "t")
    (root / "app.py").write_text("def a():\n    return 1\n", encoding="utf-8")
    _commit(root, "base")
    spec = tmp_path / "spec"
    spec.mkdir()
    return root, spec


def _validate(record: dict) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.validate(record, SCHEMA)


def test_a_session_commit_gives_a_valid_record(repo):
    root, spec = repo
    base = session_start(spec, root, "subtask-1", 3)
    (root / "app.py").write_text(
        "def a():\n    return 1\n\n\ndef b():\n    return 2\n", encoding="utf-8"
    )
    (root / "Cart.razor").write_text("<button>Pay</button>\n", encoding="utf-8")
    head = _commit(root, "subtask-1")
    record = record_session(root, spec, base=base, head=head, model_id=MODEL)
    _validate(record)
    assert record["version"] == SPEC_VERSION == "0.1"
    assert record["vcs"] == {"type": "git", "revision": head}
    files = {f["path"]: f for f in record["files"]}
    (conv,) = files["app.py"]["conversations"]
    assert conv["contributor"] == {"type": "ai", "model_id": MODEL}
    assert [(r["start_line"], r["end_line"]) for r in conv["ranges"]] == [(3, 6)]
    assert conv["ranges"][0]["content_hash"].startswith("sha256:")
    meta = record["metadata"]["ai.workpilot"]
    assert meta["subtask_id"] == "subtask-1" and meta["session"] == 3
    assert meta["base"] == base
    # No code and no prompt in the record.
    assert "return 2" not in json.dumps(record) and "Pay" not in json.dumps(record)
    assert read_records(spec) == [record]


def test_a_cli_provider_commit_without_any_hook_gives_the_same_record(repo):
    root, spec = repo
    base = _git(root, "rev-parse", "HEAD")  # no session_start, no tool notes
    (root / "app.py").write_text("def a():\n    return 2\n", encoding="utf-8")
    head = _commit(root, "codex")
    record = record_session(root, spec, base=base, head=head, model_id="openai/gpt-5.5")
    _validate(record)
    (conv,) = record["files"][0]["conversations"]
    assert conv["contributor"]["type"] == "ai"
    assert "post_processing_files" not in record["metadata"]["ai.workpilot"]


def test_lines_the_person_left_uncommitted_are_not_the_agents(repo):
    root, spec = repo
    # The person edits between two sessions and does not commit.
    (root / "app.py").write_text(
        "def a():\n    return 1\n# reviewed by Lea\n", encoding="utf-8"
    )
    base = session_start(spec, root)
    with open(root / "app.py", "a", encoding="utf-8") as handle:
        handle.write("def c():\n    return 3\n")
    head = _commit(root, "agent")
    record = record_session(root, spec, base=base, head=head, model_id=MODEL)
    _validate(record)
    by_type = {
        c["contributor"]["type"]: [
            (r["start_line"], r["end_line"]) for r in c["ranges"]
        ]
        for c in record["files"][0]["conversations"]
    }
    assert by_type == {"ai": [(4, 5)], "human": [(3, 3)]}


def test_a_file_changed_without_a_tool_write_is_noted_as_a_commands(repo):
    root, spec = repo
    base = session_start(spec, root)
    (root / "app.py").write_text("def a():\n    return 5\n", encoding="utf-8")
    note_tool_write(spec, "Edit", str(root / "app.py"))
    (root / "fmt.py").write_text("X = 1\n", encoding="utf-8")  # the formatter's
    head = _commit(root, "agent")
    record = record_session(root, spec, base=base, head=head, model_id=MODEL)
    assert record["metadata"]["ai.workpilot"]["post_processing_files"] == ["fmt.py"]
    # The next session starts with no note left over.
    session_start(spec, root)
    assert not (spec / "memory" / "agent_trace_writes.jsonl").exists()


def test_the_summary_follows_moved_code_and_does_not_guess_changed_code(repo):
    root, spec = repo
    base = session_start(spec, root)
    (root / "app.py").write_text(
        "def a():\n    return 1\n\n\ndef b():\n    return 2\n", encoding="utf-8"
    )
    head = _commit(root, "agent")
    after_session(root, spec, base, head, MODEL)
    summary = json.loads(
        (spec / "agent-trace-summary.json").read_text(encoding="utf-8")
    )
    assert summary["files"]["app.py"] == {"added": 4, "ai": 4, "human": 0, "unknown": 0}
    # A rebase-like move: the agent's lines shift down, intact.
    (root / "app.py").write_text(
        "import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 2\n",
        encoding="utf-8",
    )
    _commit(root, "person adds an import")
    moved = summarize(root, spec)
    assert moved["files"]["app.py"] == {"added": 7, "ai": 4, "human": 0, "unknown": 3}
    # The person rewrites the agent's function in review: no longer the agent's.
    (root / "app.py").write_text(
        "import os\n\n\ndef a():\n    return 1\n\n\ndef b():\n    return 20\n",
        encoding="utf-8",
    )
    _commit(root, "person edits b")
    changed = summarize(root, spec)
    assert changed["files"]["app.py"]["ai"] == 0
    line = attribution_line(moved)
    assert line.startswith("**AI attribution**") and "57% of the 7 added lines" in line
    assert MODEL in line
    assert attribution_line(None) == "" and attribution_line(changed) == ""


def test_a_full_ledger_or_a_read_only_disk_never_fails_the_build(repo, monkeypatch):
    root, spec = repo
    base = session_start(spec, root)
    (root / "app.py").write_text("def a():\n    return 9\n", encoding="utf-8")
    head = _commit(root, "agent")
    (spec / TRACE_FILE).write_bytes(b"x" * (2 * 1024 * 1024))
    assert record_session(root, spec, base=base, head=head, model_id=MODEL) is not None
    assert (spec / TRACE_FILE).stat().st_size == 2 * 1024 * 1024  # not appended

    def refuse(*_args, **_kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr("builtins.open", refuse)
    monkeypatch.setattr(Path, "write_text", refuse)
    monkeypatch.setattr(Path, "mkdir", refuse)
    after_session(root, spec, base, head, MODEL)  # does not raise
    note_tool_write(spec, "Write", "x.py")
    assert session_start(spec, root) == head
    # git cannot answer: no record, no exception.
    assert record_session(root, spec, base="nope", head=head, model_id=MODEL) is None


def test_the_pr_body_gets_the_attribution_line(repo):
    from core.worktree_pr import WorktreePRMixin

    root, _ = repo
    spec = root / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    base = session_start(spec, root)
    (root / "app.py").write_text("def a():\n    return 7\n", encoding="utf-8")
    head = _commit(root, "agent")
    after_session(root, spec, base, head, MODEL)

    class Manager(WorktreePRMixin):
        project_dir = root

        def get_worktree_path(self, _spec_name):
            return root

    body = Manager()._with_attribution("001-x", "## Summary\n")
    assert body.startswith("## Summary\n\n**AI attribution**")
    assert "100% of the 1 added lines" in body and MODEL in body
    # No record: the body is left as it was.
    assert Manager()._with_attribution("002-y", "## Summary\n") == "## Summary\n"


def test_the_model_id_never_fails_a_build():
    class Client:
        def provider_name(self):
            return "claude"

    assert model_id_of(Client(), "claude-sonnet-5-5") == "claude/claude-sonnet-5-5"
    assert model_id_of(object(), None) == "unknown/unknown"
