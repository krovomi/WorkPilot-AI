"""One memory: what the builds learn is kept in the shared vault, and only there.

WorkPilot used to remember in Graphiti when ``GRAPHITI_ENABLED`` was set and in
``<spec_dir>/memory/`` otherwise, while its agents wrote to the Obsidian vault —
three stores, each read by a different surface. These tests hold the rules that
make the vault the single one:

* **every writer lands in the vault** — the coder's session memory, the agent
  tools, the ``memory`` package, review findings — as ordinary notes;
* **every reader asks the vault** — the coder's context, the spec pipeline's
  hints, ``mem_search``;
* **nothing is lost on upgrade** — the old spec files are imported and set
  aside, and the recovery state beside them is left alone;
* **reads never create a vault, the first write does**, and
  ``BRAIN_ENABLED=false`` turns memory off rather than sending it elsewhere.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from brain import Brain  # noqa: E402
from brain.notes import read_note  # noqa: E402
from brain.project_memory import (  # noqa: E402
    LEGACY_MIGRATED,
    ProjectMemory,
    get_graph_hints,
    import_legacy_spec_memory,
    list_memories,
    search_memories,
)


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    return root


@pytest.fixture
def spec(tmp_path):
    """``<project>/.workpilot/specs/001-login`` — what a build hands the memory."""
    project = tmp_path / "shop"
    spec_dir = project / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    return spec_dir


def _memory_files(root: Path, kind: str) -> list[Path]:
    folder = root / "knowledge" / "projects" / "shop" / "memory" / kind
    return sorted(folder.rglob("*.md")) if folder.is_dir() else []


def _commits(root: Path) -> int:
    out = subprocess.run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    return int(out.stdout.strip() or 0)


# ---------------------------------------------------------------------------
# Where memory lives, and when the vault is created
# ---------------------------------------------------------------------------


def test_reading_never_creates_a_vault(vault, spec):
    memory = ProjectMemory(spec)
    assert memory.load_gotchas() == []
    assert memory.search("anything") == []
    assert not vault.exists()


def test_the_first_write_creates_a_local_vault(vault, spec):
    memory = ProjectMemory(spec)
    assert memory.record_gotcha("Close the DB connection in workers")
    memory.flush()
    assert Brain(vault).exists
    [note] = _memory_files(vault, "gotchas")
    meta = read_note(vault, note.relative_to(vault)).meta
    assert meta["memory"] == "gotcha"
    assert meta["project"] == "shop"
    assert meta["tasks"] == ["shop/001-login"]
    # linked to the project hub and the build note, like every note of a task
    body = note.read_text(encoding="utf-8")
    assert "[[knowledge/projects/shop/index]]" in body
    assert "[[knowledge/projects/shop/builds/001-login]]" in body


def test_memory_off_writes_nothing_anywhere(vault, spec, monkeypatch):
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    memory = ProjectMemory(spec)
    assert not memory.is_enabled
    assert not memory.record_gotcha("x marks the spot")
    assert not vault.exists()
    assert not (spec / "memory").exists()


def test_the_project_is_named_through_a_worktree(vault, tmp_path):
    worktree_spec = (
        tmp_path
        / "shop"
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-login"
        / ".workpilot"
        / "specs"
        / "001-login"
    )
    worktree_spec.mkdir(parents=True)
    assert ProjectMemory(worktree_spec).project == "shop"


# ---------------------------------------------------------------------------
# What is written
# ---------------------------------------------------------------------------


def test_the_same_gotcha_twice_is_one_note(vault, spec):
    memory = ProjectMemory(spec)
    memory.record_gotcha("Rate limit: 100 req/min per IP")
    memory.record_gotcha("Rate limit: 100 req/min per IP")
    memory.flush()
    assert len(_memory_files(vault, "gotchas")) == 1


def test_a_secret_never_reaches_the_vault(vault, spec):
    memory = ProjectMemory(spec)
    memory.record_gotcha("Login fails unless api_key=sk-live-1234567890abcdef is set")
    memory.flush()
    [note] = _memory_files(vault, "gotchas")
    text = note.read_text(encoding="utf-8")
    assert "sk-live-1234567890abcdef" not in text
    assert "redacted" in text


def test_a_session_files_its_discoveries_as_their_own_notes(vault, spec):
    memory = ProjectMemory(spec)
    memory.record_session(
        1,
        {
            "subtasks_completed": ["subtask-1"],
            "discoveries": {
                "files_understood": {"src/auth.py": "JWT validation"},
                "patterns_found": ["Services return Result objects"],
                "gotchas_encountered": ["Tokens expire after 5 minutes in tests"],
            },
            "recommendations_for_next_session": ["Add the refresh endpoint"],
        },
    )
    memory.flush()
    assert len(_memory_files(vault, "codebase")) == 1
    assert len(_memory_files(vault, "patterns")) == 1
    assert len(_memory_files(vault, "gotchas")) == 1
    [session] = memory.load_sessions()
    assert session["session_number"] == 1
    assert session["recommendations_for_next_session"] == ["Add the refresh endpoint"]
    assert memory.load_codebase_map() == {"src/auth.py": "JWT validation"}


def test_coder_and_qa_fixer_sessions_do_not_overwrite_each_other(vault, spec):
    memory = ProjectMemory(spec)
    memory.record_session(1, {"subtasks_completed": ["subtask-1"]})
    memory.record_session(1, {"subtasks_completed": ["qa_fixer_1"]})
    memory.flush()
    assert len(_memory_files(vault, "sessions")) == 2


def test_many_notes_are_one_commit(vault, spec):
    memory = ProjectMemory(spec)
    memory.record_gotcha("first")
    memory.flush()
    before = _commits(vault)
    for i in range(5):
        memory.record_pattern(f"pattern number {i} about services")
    memory.flush()
    assert _commits(vault) == before + 1


def test_the_whole_project_shares_one_memory(vault, spec):
    ProjectMemory(spec).record_gotcha("Migrations must be idempotent")
    other = spec.parent / "002-cart"
    other.mkdir()
    assert "Migrations must be idempotent" in ProjectMemory(other).load_gotchas()


# ---------------------------------------------------------------------------
# What is read back
# ---------------------------------------------------------------------------


def test_patterns_and_gotchas_are_ranked_by_the_subtask(vault, spec):
    memory = ProjectMemory(spec)
    memory.record_gotcha("Stripe webhooks arrive twice: make the handler idempotent")
    memory.record_gotcha("The CSS build needs node 20")
    memory.flush()

    patterns, gotchas = asyncio.run(
        memory.get_patterns_and_gotchas(
            "Handle the Stripe payment webhook", num_results=3, min_score=0.3
        )
    )
    assert [g["gotcha"] for g in gotchas] == [
        "Stripe webhooks arrive twice: make the handler idempotent"
    ]
    assert patterns == []


def test_the_coder_context_comes_from_the_vault(vault, spec):
    from agents.memory_manager import get_memory_context, save_session_memory

    ok, store = asyncio.run(
        save_session_memory(
            spec_dir=spec,
            project_dir=spec.parents[2],
            subtask_id="subtask-1",
            session_num=1,
            success=True,
            subtasks_completed=["subtask-1"],
            discoveries={
                "files_understood": {},
                "patterns_found": [],
                "gotchas_encountered": ["Payment amounts are in cents, never floats"],
            },
        )
    )
    assert (ok, store) == (True, "brain")
    context = asyncio.run(
        get_memory_context(
            spec,
            spec.parents[2],
            {"id": "subtask-2", "description": "Compute the payment amounts"},
        )
    )
    assert context and "Payment amounts are in cents" in context


def test_the_memory_package_reads_and_writes_the_vault(vault, spec):
    from memory import append_gotcha, append_pattern, load_gotchas, load_patterns

    append_gotcha(spec, "Never call the ERP from a request thread")
    append_pattern(spec, "Handlers are thin, services hold the logic")
    assert load_gotchas(spec) == ["Never call the ERP from a request thread"]
    assert load_patterns(spec) == ["Handlers are thin, services hold the logic"]
    assert not (spec / "memory").exists()
    assert len(_memory_files(vault, "gotchas")) == 1


def test_hints_for_the_spec_pipeline_come_from_the_vault(vault, spec):
    ProjectMemory(spec).record_gotcha("The invoice PDF needs the fr-FR locale")
    hints = asyncio.run(
        get_graph_hints("invoice PDF locale", project_id=str(spec.parents[2]))
    )
    assert hints and hints[0]["type"] == "gotcha"
    assert "fr-FR" in hints[0]["content"]


def test_hints_without_a_vault_are_empty(vault, spec):
    assert (
        asyncio.run(get_graph_hints("anything", project_id=str(spec.parents[2]))) == []
    )


def test_the_memories_tab_lists_and_searches_the_vault(vault, spec):
    memory = ProjectMemory(spec)
    memory.record_gotcha("Cache keys include the tenant id")
    memory.record_pattern("DTOs are records")
    memory.flush()
    listed = list_memories("shop")
    assert {m["type"] for m in listed} == {"gotcha", "pattern"}
    found = search_memories("shop", "tenant cache")
    assert [f["type"] for f in found] == ["gotcha"]


def test_mem_search_sees_the_vault(vault, spec):
    from mem_search import search_for

    ProjectMemory(spec).record_gotcha("Flaky timeout in the integration suite")
    index = search_for(spec.parents[2]).index("flaky timeout")
    assert any(ref.id.startswith("brain:") for ref in index.refs)
    record = search_for(spec.parents[2]).detail(
        next(ref.id for ref in index.refs if ref.id.startswith("brain:"))
    )
    assert record and "Flaky timeout" in record.body


# ---------------------------------------------------------------------------
# The files the old store left behind
# ---------------------------------------------------------------------------


def _legacy(spec_dir: Path) -> Path:
    legacy = spec_dir / "memory"
    (legacy / "session_insights").mkdir(parents=True)
    (legacy / "codebase_map.json").write_text(
        json.dumps(
            {
                "discovered_files": {
                    "src/cart.py": {"description": "Cart totals", "category": "api"}
                },
                "last_updated": "2026-01-01",
            }
        ),
        encoding="utf-8",
    )
    (legacy / "gotchas.md").write_text(
        "# Gotchas & Pitfalls\n\nThings to watch out for in this codebase.\n"
        "\n## [2026-01-01 10:00]\nVAT is rounded per line\n\n_Context: invoices_\n",
        encoding="utf-8",
    )
    (legacy / "patterns.md").write_text(
        "# Code Patterns\n\nEstablished patterns to follow in this codebase:\n\n"
        "- Money is a value object\n",
        encoding="utf-8",
    )
    (legacy / "session_insights" / "session_001.json").write_text(
        json.dumps({"session_number": 1, "what_worked": ["TDD"]}), encoding="utf-8"
    )
    # recovery state: execution state, not knowledge — must stay put
    (legacy / "attempt_history.json").write_text('{"attempts": []}', encoding="utf-8")
    return legacy


def test_the_old_spec_memory_is_imported_and_set_aside(vault, spec):
    legacy = _legacy(spec)
    report = import_legacy_spec_memory(spec)
    assert report["imported"] >= 4
    memory = ProjectMemory(spec)
    assert memory.load_codebase_map() == {"src/cart.py": "Cart totals"}
    assert any("VAT is rounded per line" in g for g in memory.load_gotchas())
    assert memory.load_patterns() == ["Money is a value object"]
    assert memory.load_sessions()[0]["what_worked"] == ["TDD"]
    # the knowledge moved aside, the recovery state did not
    assert (spec / LEGACY_MIGRATED / "gotchas.md").is_file()
    assert not (legacy / "gotchas.md").exists()
    assert (legacy / "attempt_history.json").is_file()


def test_the_old_memory_is_imported_on_first_use(vault, spec):
    _legacy(spec)
    Brain(vault).init()
    assert "Money is a value object" in ProjectMemory(spec).load_patterns()
    assert (spec / LEGACY_MIGRATED).is_dir()


def test_a_second_import_never_overwrites_the_first(vault, spec):
    _legacy(spec)
    import_legacy_spec_memory(spec)
    (spec / "memory" / "patterns.md").write_text("- Another one\n", encoding="utf-8")
    import_legacy_spec_memory(spec)
    set_aside = sorted(
        p.name for p in spec.iterdir() if p.name.startswith(LEGACY_MIGRATED)
    )
    assert len(set_aside) == 2
    assert (spec / LEGACY_MIGRATED / "gotchas.md").is_file()


# ---------------------------------------------------------------------------
# The other writers
# ---------------------------------------------------------------------------


def test_review_findings_become_gotchas_high_severity_only(vault, spec):
    from runners.github.services.deep_context_provider import store_review_learnings

    asyncio.run(
        store_review_learnings(
            spec.parents[2],
            42,
            [
                {
                    "severity": "high",
                    "title": "SQL built by concatenation",
                    "file": "src/db.py",
                },
                {"severity": "low", "title": "Typo in a comment"},
            ],
            "Add search",
            ["src/db.py"],
        )
    )
    gotchas = ProjectMemory(project="shop").load_gotchas()
    assert len(gotchas) == 1 and "SQL built by concatenation" in gotchas[0]


def test_no_agent_gets_the_graphiti_server_by_default(monkeypatch):
    from agents.tools_pkg.models import AGENT_CONFIGS, get_required_mcp_servers

    monkeypatch.setenv("GRAPHITI_MCP_URL", "http://localhost:9000/mcp/")
    for agent_type in AGENT_CONFIGS:
        assert "graphiti" not in get_required_mcp_servers(agent_type)
