"""What an agent recalls of a scoped memory (#352).

A note's ``applies_to`` can name a git branch (``branch:release/2.0``) or a
team (``team:payments``). These tests hold the maintainer's rules:

* a ``branch:`` note is recalled only by a build on that branch, or on one
  under it at a ``/``; never when the branch cannot be read;
* a ``team:`` note is recalled, on a server, only by a run its group's member
  started; locally, by every build, as before;
* a note without a scope, or scoped to a module, is recalled as before;
* a person's surfaces (the Memories tab) still show every note;
* the three recall paths (the project memory, the ``workpilot-brain`` tools,
  ``mem_search``) share one filter, `scopes.recalled`.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from brain import Brain, project_memory, runtime
from brain.lifecycle import scopes
from brain.lifecycle.scopes import Audience
from brain.mcp_server import RECALL_TOOLS, _call
from brain.notes import Note, write_note
from brain.project_memory import (
    ProjectMemory,
    get_graph_hints,
    list_memories,
    open_project_memory,
    search_memories,
)

BASE = "knowledge/projects/shop/memory"

NOTES = {
    "everywhere": "",
    "module": "apps/billing/",
    "release": "branch:release",
    "release-2": "branch:release/2.0",
    "main": "branch:main",
    "payments": "team:Payments",
    "typo": "branch:main feature",
}


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv(scopes.BRANCH_ENV, raising=False)
    monkeypatch.delenv(scopes.TEAMS_ENV, raising=False)
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def checkout(folder: Path, branch: str) -> Path:
    """A repository on *branch* (unborn: no commit is needed to read it)."""
    folder.mkdir(parents=True, exist_ok=True)
    git(folder, "init", "-q")
    git(folder, "checkout", "-q", "-b", branch)
    return folder


@pytest.fixture
def vault(tmp_path, monkeypatch) -> Brain:
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(tmp_path / "home"))
    brain = Brain(root)
    brain.init()
    for name, scope in NOTES.items():
        meta = {
            "title": f"Scoped {name} retry",
            "kind": "knowledge",
            "memory": "gotcha",
            "project": "shop",
            "created": f"2026-11-0{len(name) % 9 + 1}T10:00:00+00:00",
        }
        if scope:
            meta["applies_to"] = scope
        write_note(
            root,
            Note(
                path=Path(f"{BASE}/gotchas/{name}.md"),
                meta=meta,
                body=f"Scoped {name} retry the webhook",
            ),
        )
    brain._refresh()
    return brain


def names(hits) -> set[str]:
    return {Path(str(h.get("path") or h.get("source_file"))).stem for h in hits}


# --------------------------------------------------------------------------- #
# The rule
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("scope", "branch", "expected"),
    [
        ("branch:release/2.0", "release/2.0", True),
        ("Branch: Release/2.0", "release/2.0", True),
        ("branch:release/2.0", "release/3.0", False),
        ("branch:release", "release/2.0", True),
        ("branch:release/", "release/2.0", True),
        ("branch:release", "release-2.0", False),
        ("branch:release/2.0", "release", False),
        ("branch:release/2.0", None, False),
        ("branch:main feature", "main", False),
        ("branch:", "main", False),
        ("", None, True),
        ("apps/billing/", None, True),
        (None, "main", True),
    ],
)
def test_a_branch_note_follows_its_branch(scope, branch, expected):
    assert scopes.recalled(scope, Audience(branch=branch)) is expected


@pytest.mark.parametrize(
    ("teams", "expected"),
    [
        (None, True),  # local: every build
        (frozenset({"team:payments"}), True),
        (frozenset({"team:front"}), False),
        (frozenset(), False),
    ],
)
def test_a_team_note_follows_its_team_on_a_server_only(teams, expected):
    assert scopes.recalled("team:Payments", Audience(teams=teams)) is expected
    # A team never decides for a note without one.
    assert scopes.recalled("", Audience(teams=teams)) is True


def test_the_run_s_teams_are_read_from_the_environment():
    assert scopes.teams_from({}) is None
    assert scopes.teams_from({scopes.TEAMS_ENV: "[]"}) == frozenset()
    assert scopes.teams_from(
        {scopes.TEAMS_ENV: json.dumps(["Payments", " Front team ", "", 3])}
    ) == frozenset({"team:payments", "team:front team"})
    # Unreadable on a server: no team, never every team.
    assert scopes.teams_from({scopes.TEAMS_ENV: "Payments"}) == frozenset()
    assert scopes.teams_from({scopes.TEAMS_ENV: '{"a": 1}'}) == frozenset()


def test_the_branch_is_read_from_the_worktree(tmp_path):
    assert scopes.branch_of(checkout(tmp_path / "repo", "release/2.0")) == (
        "release/2.0"
    )
    assert scopes.branch_of(tmp_path / "absent") is None
    assert scopes.branch_of(None) is None
    plain = tmp_path / "plain"
    plain.mkdir()
    assert scopes.branch_of(plain) is None


def test_a_detached_head_has_no_branch(tmp_path):
    repo = checkout(tmp_path / "repo", "main")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@x.test", "commit", "-q",
        "--allow-empty", "-m", "first")  # fmt: skip
    git(repo, "checkout", "-q", "--detach")
    assert scopes.branch_of(repo) is None


def test_the_audience_of_a_build(tmp_path):
    repo = checkout(tmp_path / "repo", "release/2.0")
    assert scopes.audience(repo, environ={}) == Audience("release/2.0", None)
    teams = {scopes.TEAMS_ENV: '["Payments"]'}
    assert scopes.audience(repo, environ=teams).teams == {"team:payments"}
    # The branch WorkPilot named for a brain server wins over the folder's.
    named = {scopes.BRANCH_ENV: " main "}
    assert scopes.audience(repo, environ=named).branch == "main"
    assert scopes.audience(repo, environ={scopes.BRANCH_ENV: ""}).branch is None
    assert scopes.audience(repo, environ={scopes.BRANCH_ENV: "a..b"}).branch is None


# --------------------------------------------------------------------------- #
# Path 1: the project memory a build reads
# --------------------------------------------------------------------------- #


def test_a_build_recalls_its_branch_s_notes_only(vault, tmp_path):
    worktree = checkout(tmp_path / "shop", "release/2.0")
    memory = open_project_memory(None, worktree)

    assert memory is not None and memory.audience.branch == "release/2.0"
    recalled = names(memory.search("retry webhook", limit=20))
    assert recalled == {"everywhere", "module", "release", "release-2", "payments"}
    assert len(memory.load_gotchas()) == 5


def test_a_build_whose_branch_is_unknown_recalls_no_branch_note(vault, tmp_path):
    folder = tmp_path / "shop"
    folder.mkdir()
    memory = open_project_memory(None, folder)

    assert memory is not None and memory.audience == Audience(None, None)
    assert names(memory.search("", limit=20)) == {"everywhere", "module", "payments"}


def test_a_server_run_recalls_its_starter_s_teams_only(vault, tmp_path, monkeypatch):
    worktree = checkout(tmp_path / "shop", "main")
    monkeypatch.setenv(scopes.TEAMS_ENV, '["Front"]')
    outsider = open_project_memory(None, worktree)
    assert names(outsider.search("", limit=20)) == {"everywhere", "module", "main"}

    monkeypatch.setenv(scopes.TEAMS_ENV, '["payments"]')
    member = open_project_memory(None, worktree)
    assert "payments" in names(member.search("", limit=20))


def test_the_agent_doors_recall_for_their_build(vault, tmp_path):
    from memory.store import get_project_memory

    worktree = checkout(tmp_path / "shop", "main")
    spec = worktree / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)

    assert get_project_memory(spec, worktree).audience.branch == "main"
    # Without the project folder, the spec's own is read.
    assert get_project_memory(spec).audience.branch == "main"


def test_every_read_of_a_build_is_filtered(vault, tmp_path):
    worktree = checkout(tmp_path / "shop", "main")
    memory = open_project_memory(None, worktree)
    root = vault.root
    for rel, meta in (
        (f"{BASE}/patterns/p.md", {"memory": "pattern", "applies_to": "branch:dev"}),
        (
            f"{BASE}/codebase/c.md",
            {"memory": "codebase", "file": "a.py", "applies_to": "branch:dev"},
        ),
        (
            f"{BASE}/sessions/s.md",
            {"memory": "session", "session_number": 1, "applies_to": "branch:dev"},
        ),
    ):
        write_note(
            root, Note(path=Path(rel), meta={"project": "shop", **meta}, body="x")
        )

    assert memory.load_patterns() == []
    assert memory.load_codebase_map() == {}
    assert memory.load_sessions(spec_only=False) == []
    person = ProjectMemory(project="shop")
    assert len(person.load_patterns()) == 1
    assert person.load_codebase_map() == {"a.py": "x"}


def test_the_session_context_of_a_build_is_filtered(vault, tmp_path):
    worktree = checkout(tmp_path / "shop", "feature/x")
    memory = open_project_memory(None, worktree)
    _, gotchas = asyncio.run(
        memory.get_patterns_and_gotchas("retry webhook", num_results=20, min_score=0)
    )
    # Everywhere, the module and the team (local): no branch note is for feature/x.
    assert {g["gotcha"].split()[1] for g in gotchas} == {
        "everywhere",
        "module",
        "payments",
    }


def test_a_person_s_surfaces_show_every_note(vault, tmp_path):
    checkout(tmp_path / "shop", "main")
    listed = list_memories("shop", limit=50)
    assert {Path(m["path"]).stem for m in listed} == set(NOTES)
    assert {m["applies_to"] for m in listed} == {s for s in NOTES.values()}
    assert names(search_memories("shop", "retry webhook", limit=50)) == set(NOTES)


def test_the_hints_of_a_feature_are_filtered_in_memory_and_vault(vault, tmp_path):
    worktree = checkout(tmp_path / "shop", "main")
    hints = asyncio.run(get_graph_hints("retry", str(worktree), max_results=50))
    assert names(hints) == {"everywhere", "module", "main", "payments"}


def test_the_hints_fill_up_from_the_vault_with_the_same_filter(vault, tmp_path):
    worktree = checkout(tmp_path / "shop", "main")
    # A note of another project the vault-wide recall finds, scoped away.
    write_note(
        vault.root,
        Note(
            path=Path("knowledge/elsewhere-retry.md"),
            meta={"title": "Elsewhere retry", "applies_to": "branch:dev"},
            body="retry",
        ),
    )
    write_note(
        vault.root,
        Note(
            path=Path("knowledge/open-retry.md"), meta={"title": "Open retry"}, body="x"
        ),
    )
    vault._refresh()
    hints = asyncio.run(get_graph_hints("retry", str(worktree), max_results=50))
    assert "open-retry" in names(hints)
    assert "elsewhere-retry" not in names(hints)


# --------------------------------------------------------------------------- #
# Path 2: the workpilot-brain tools
# --------------------------------------------------------------------------- #


def test_brain_recall_leaves_out_what_another_branch_wrote(vault):
    on_main = Audience(branch="main")
    result = vault.recall("scoped", limit=20, audience=on_main)
    assert names(result["hits"]) == {"everywhere", "module", "main", "payments"}
    shown = {h["frontmatter"].get("applies_to", "") for h in result["hits"]}
    assert "branch:main" in shown
    # Without an audience (a person's call), every note.
    assert names(vault.recall("scoped", limit=20)["hits"]) == set(NOTES)


def test_brain_recall_still_fills_its_limit(vault):
    hits = vault.recall("scoped", limit=2, audience=Audience(branch=None))["hits"]
    assert len(hits) == 2
    assert not names(hits) & {"release", "release-2", "main", "typo"}


def test_brain_recall_falls_back_to_the_index_with_the_filter(vault):
    hits = vault.recall("webhook", limit=20, audience=Audience(branch="main"))
    assert hits["level"] == "index"
    assert names(hits["hits"]) == {"everywhere", "module", "main", "payments"}


def test_the_mcp_tools_recall_for_the_build_they_serve(vault, monkeypatch):
    monkeypatch.setenv(scopes.BRANCH_ENV, "release/2.0")
    monkeypatch.setenv(scopes.TEAMS_ENV, "[]")
    recalled = _call(vault, "brain_recall", {"query": "scoped", "limit": 20})
    assert names(recalled["hits"]) == {"everywhere", "module", "release", "release-2"}
    graph = _call(vault, "query_graph", {"query": "scoped", "limit": 3})
    assert len(graph) == 3
    assert not names(graph) & {"main", "payments", "typo"}
    # A named read is not a recall.
    assert _call(vault, "brain_read_note", {"path": f"{BASE}/gotchas/main.md"})


def test_a_person_s_agent_recalls_for_the_folder_it_runs_in(
    vault, tmp_path, monkeypatch
):
    monkeypatch.chdir(checkout(tmp_path / "repo", "main"))
    recalled = _call(vault, "brain_recall", {"query": "scoped", "limit": 20})
    assert names(recalled["hits"]) == {"everywhere", "module", "main", "payments"}


def test_the_server_config_names_the_build_s_branch_and_teams(tmp_path, monkeypatch):
    worktree = checkout(tmp_path / "shop", "release/2.0")
    env = runtime.mcp_server_config(tmp_path, task="shop/001", project_dir=worktree)[
        "env"
    ]
    assert env[scopes.BRANCH_ENV] == "release/2.0"
    assert scopes.TEAMS_ENV not in env

    monkeypatch.setenv(scopes.TEAMS_ENV, '["Payments"]')
    plain = tmp_path / "plain"
    plain.mkdir()
    env = runtime.mcp_server_config(tmp_path, project_dir=plain)["env"]
    assert env[scopes.BRANCH_ENV] == ""  # unknown: no branch note
    assert env[scopes.TEAMS_ENV] == '["Payments"]'
    # A person's agent (no folder): the server reads its own.
    assert scopes.BRANCH_ENV not in runtime.mcp_server_config(tmp_path)["env"]


def test_in_process_tools_recall_for_the_build_s_folder(vault, tmp_path, monkeypatch):
    worktree = checkout(tmp_path / "shop", "main")
    seen: list[object] = []
    real = scopes.audience

    def spy(directory, **kwargs):
        seen.append(directory)
        return real(directory, **kwargs)

    monkeypatch.setattr(scopes, "audience", spy)
    text = asyncio.run(
        runtime.execute_tool("brain_recall", {"query": "scoped"}, project_dir=worktree)
    )
    assert seen == [worktree]
    assert "release-2" not in text
    asyncio.run(
        runtime.execute_tool(
            "brain_write_note", {"title": "t", "body": "b"}, project_dir=worktree
        )
    )
    assert seen == [worktree]  # a write reads no branch
    assert RECALL_TOOLS == ("brain_recall", "query_graph")


# --------------------------------------------------------------------------- #
# Path 3: mem_search
# --------------------------------------------------------------------------- #


def test_mem_search_leaves_out_what_another_branch_wrote(vault, tmp_path):
    from mem_search import BrainSource

    worktree = checkout(tmp_path / "shop", "main")
    refs = BrainSource(worktree).refs("scoped", 50)
    assert {Path(r.id).stem for r in refs} == {
        "everywhere",
        "module",
        "main",
        "payments",
    }
    # Nor can its detail be asked for by id.
    assert BrainSource(worktree).load(f"brain:{BASE}/gotchas/release.md") is None


# --------------------------------------------------------------------------- #
# One filter for the three
# --------------------------------------------------------------------------- #


def test_the_three_recall_paths_share_one_filter(vault, tmp_path, monkeypatch):
    from mem_search import BrainSource

    worktree = checkout(tmp_path / "shop", "main")
    asked: list[object] = []

    def nothing(applies_to, audience):
        asked.append(applies_to)
        return False

    monkeypatch.setattr(scopes, "recalled", nothing)

    assert open_project_memory(None, worktree).search("", limit=50) == []
    assert asked, "the project memory bypassed the filter"
    asked.clear()
    assert _call(vault, "brain_recall", {"query": "scoped"})["hits"] == []
    assert _call(vault, "query_graph", {"query": "scoped"}) == []
    assert asked, "the brain tools bypassed the filter"
    asked.clear()
    assert BrainSource(worktree).refs("scoped", 50) == []
    assert asked, "mem_search bypassed the filter"
    # A person's surface never asks it.
    asked.clear()
    assert len(list_memories("shop", limit=50)) == len(NOTES)
    assert asked == []


def test_project_memory_exports_its_agent_door():
    assert "agent_memory" in project_memory.__all__


def test_a_hit_that_is_not_a_note_is_always_recalled(vault, monkeypatch):
    class Graph:
        def query(self, query, limit):
            return [{"id": "img", "source_file": "assets/shot.png"}, {"id": "tag"}]

    monkeypatch.setattr(vault, "graph", lambda: Graph())
    hits = vault.recall("shot", limit=5, audience=Audience(branch=None))["hits"]
    assert [h["id"] for h in hits] == ["img", "tag"]
    assert all("frontmatter" not in h for h in hits)
    assert vault.recalled(Graph().query("", 0), Audience(), 1) == [
        {"id": "img", "source_file": "assets/shot.png"}
    ]
