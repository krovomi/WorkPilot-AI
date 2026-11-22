"""The learning loop's patterns, recalled by scope (#352).

A pattern note can carry an ``applies_to`` like any memory (`store.scope`).
These tests hold the rules:

* what goes to an agent (the prompt injector, ``mem_search``'s
  `PatternSource`) leaves out a pattern scoped to another branch or, on a
  server, another team (`scopes.recalled`);
* the store's own read (`PatternStorage.load_patterns`) still reads them
  all, so a write after a build on another branch keeps them: the store
  forgets the patterns it does not see.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from brain import Brain
from brain.lifecycle import scopes, store
from brain.notes import read_note
from brain.project_memory import ProjectMemory, open_project_memory

BASE = "knowledge/projects/shop/memory"


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _checkout(folder: Path, branch: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    _git(folder, "init", "-q")
    _git(folder, "checkout", "-q", "-b", branch)
    return folder


def _pattern(pattern_id: str, instruction: str):
    from learning_loop.models import LearningPattern

    return LearningPattern(
        pattern_id=pattern_id,
        category="qa_pattern",
        pattern_type="success",
        source="qa_feedback",
        description=f"Pattern {pattern_id}",
        confidence=0.9,
        occurrence_count=3,
        context_tags=[],
        actionable_instruction=instruction,
        source_build_ids=["b1"],
        agent_phase="coding",
    )


SCOPED = {
    "everywhere": ("", "Run the linters before committing anything."),
    "on-main": ("branch:main", "Rebase onto main before opening a pull request."),
    "on-dev": ("branch:dev", "Keep the feature flags off on the dev line."),
    "payments": ("team:payments", "Ask the payments team before touching invoices."),
}


@pytest.fixture
def vault(tmp_path, monkeypatch) -> Brain:
    monkeypatch.delenv(scopes.BRANCH_ENV, raising=False)
    monkeypatch.delenv(scopes.TEAMS_ENV, raising=False)
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(tmp_path / "home"))
    brain = Brain(root)
    brain.init()
    from learning_loop.pattern_storage import PatternStorage

    PatternStorage(project="shop").save_patterns(
        [_pattern(pid, text) for pid, (_, text) in SCOPED.items()]
    )
    for pid, (scope, _) in SCOPED.items():
        if scope:
            done = store.scope(root, BASE, f"patterns/{pid}.md", scope)
            assert done["ok"], done
    return brain


def _ids(patterns) -> set[str]:
    return {p.pattern_id if hasattr(p, "pattern_id") else p for p in patterns}


def test_a_build_s_prompt_carries_only_the_patterns_it_recalls(vault, tmp_path):
    from learning_loop.pattern_storage import PatternStorage

    storage = PatternStorage(_checkout(tmp_path / "shop", "main"))

    assert _ids(storage.recall_patterns()) == {"everywhere", "on-main", "payments"}
    assert _ids(storage.get_patterns_for_phase("coding")) == {
        "everywhere",
        "on-main",
        "payments",
    }
    # The store's own read sees every pattern.
    assert _ids(storage.load_patterns()) == set(SCOPED)


def test_the_injector_leaves_another_branch_s_pattern_out(vault, tmp_path):
    from learning_loop.prompt_injection import get_learning_context

    worktree = _checkout(tmp_path / "shop", "dev")
    text = get_learning_context(worktree, "coding")

    assert "feature flags off" in text
    assert "Rebase onto main" not in text
    assert "linters" in text


def test_a_server_run_gets_only_its_starter_s_team_patterns(
    vault, tmp_path, monkeypatch
):
    from learning_loop.pattern_storage import PatternStorage

    worktree = _checkout(tmp_path / "shop", "main")
    monkeypatch.setenv(scopes.TEAMS_ENV, '["Front"]')
    assert "payments" not in _ids(PatternStorage(worktree).recall_patterns())
    monkeypatch.setenv(scopes.TEAMS_ENV, '["Payments"]')
    assert "payments" in _ids(PatternStorage(worktree).recall_patterns())


def test_a_build_whose_branch_is_unknown_recalls_no_branch_pattern(vault, tmp_path):
    from learning_loop.pattern_storage import PatternStorage

    plain = tmp_path / "shop"
    plain.mkdir()
    assert _ids(PatternStorage(plain).recall_patterns()) == {"everywhere", "payments"}


def test_mem_search_answers_only_the_recalled_patterns(vault, tmp_path):
    from mem_search import PatternSource

    source = PatternSource(_checkout(tmp_path / "shop", "main"))
    refs = {r.id for r in source.refs("", 50)}

    assert refs == {"pattern:everywhere", "pattern:on-main", "pattern:payments"}
    assert source.load("pattern:on-dev") is None


def test_a_scoped_pattern_survives_a_write_from_another_branch(vault, tmp_path):
    """The prompt's read is filtered, the store's write is not: recording an
    application (what each prompt does) and a new build's patterns keep the
    patterns this build does not recall, with their scope."""
    from learning_loop.pattern_storage import PatternStorage

    storage = PatternStorage(_checkout(tmp_path / "shop", "main"))
    kept = storage.get_patterns_for_phase("coding")
    storage.record_application([p.pattern_id for p in kept])
    storage.add_patterns([_pattern("new-one", "Write the changelog fragment first.")])
    storage.record_outcome(["on-main"], True)
    storage.toggle_pattern("everywhere")

    everything = {p.pattern_id: p for p in storage.load_patterns()}
    assert set(everything) == set(SCOPED) | {"new-one"}
    assert everything["on-main"].applied_count == 1
    assert everything["on-dev"].applied_count == 0
    note = read_note(vault.root, f"{BASE}/patterns/on-dev.md")
    assert note.meta["applies_to"] == "branch:dev"
    assert (vault.root / BASE / "patterns" / "payments.md").is_file()
    # Nothing went to the trash.
    assert not (vault.root / BASE / ".lifecycle" / "forgotten").exists()


def test_a_person_s_storage_sees_every_pattern(vault):
    from learning_loop.pattern_storage import PatternStorage

    # The HTTP API's storage (a project by name) recalls for no build.
    assert _ids(PatternStorage(project="shop").recall_patterns()) == set(SCOPED)


def test_the_memory_names_what_its_agents_do_not_get(vault, tmp_path):
    person = ProjectMemory(project="shop")
    assert person.unrecalled_pattern_ids() == set()
    build = open_project_memory(None, _checkout(tmp_path / "shop", "main"))
    assert build.unrecalled_pattern_ids() == {"on-dev"}


def test_the_recall_shares_the_one_filter(vault, tmp_path, monkeypatch):
    from learning_loop.pattern_storage import PatternStorage

    asked: list[object] = []

    def nothing(applies_to, audience):
        asked.append(applies_to)
        return False

    monkeypatch.setattr(scopes, "recalled", nothing)
    storage = PatternStorage(_checkout(tmp_path / "shop", "main"))
    assert storage.recall_patterns() == []
    assert asked
    asked.clear()
    assert len(storage.load_patterns()) == len(SCOPED)
    assert asked == []


def test_a_recall_that_fails_is_empty_not_an_error(vault, tmp_path, monkeypatch):
    from learning_loop.pattern_storage import PatternStorage

    def broken(self):
        raise RuntimeError("unreadable")

    monkeypatch.setattr(ProjectMemory, "unrecalled_pattern_ids", broken)
    storage = PatternStorage(_checkout(tmp_path / "shop", "main"))
    assert storage.recall_patterns() == []
    assert len(storage.load_patterns()) == len(SCOPED)


def test_memory_off_recalls_nothing(vault, tmp_path, monkeypatch):
    from learning_loop.pattern_storage import PatternStorage

    monkeypatch.setenv("BRAIN_ENABLED", "false")
    storage = PatternStorage(_checkout(tmp_path / "shop", "main"))
    assert storage.recall_patterns() == [] and storage.load_patterns() == []
