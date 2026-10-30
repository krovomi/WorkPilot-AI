"""A second engine reads the finished task; only its disagreement holds the PR (IA2).

The verdict has three values and one green light. Whatever is unclear —
no answer, prose, a disagreement that names nothing — is ``inconclusive``,
which never blocks and is never read as ``agree``. A ``disagree`` blocks the
pull request of the exact code it read, and nothing else.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from core.worktree import WorktreeManager  # noqa: E402
from cross_review.review import (  # noqa: E402
    VERDICT_FILE,
    Reviewer,
    Verdict,
    blocking_verdict,
    parse_verdict,
    read_verdict,
    tree_fingerprint,
    write_verdict,
)
from workflows.cross_review_phase import (  # noqa: E402
    ENV_EFFORT,
    ENV_MODEL,
    ENV_PROVIDER,
    resolve_reviewer,
)

from workflows import cross_review_phase as cross_phase  # noqa: E402

BLOCKER = {
    "severity": "blocker",
    "file": "src/Orders/OrdersController.cs",
    "line": 42,
    "issue": "DELETE /orders/{id} is in the spec and not implemented.",
}


@pytest.fixture(autouse=True)
def _no_engine(monkeypatch):
    for name in (ENV_PROVIDER, ENV_MODEL, ENV_EFFORT):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def spec_dir(tmp_path) -> Path:
    path = tmp_path / "specs" / "004-orders"
    path.mkdir(parents=True)
    return path


def _answer(**payload) -> str:
    return "Here is my review.\n```json\n" + json.dumps(payload) + "\n```\n"


class TestWhichEngineReviews:
    def test_nothing_configured_runs_nothing(self, spec_dir):
        reviewer, why = resolve_reviewer(spec_dir, "claude")
        assert reviewer is None
        assert why == "no second engine configured"

    def test_the_project_setting_names_the_engine(self, spec_dir, monkeypatch):
        monkeypatch.setenv(ENV_PROVIDER, "openai")
        monkeypatch.setenv(ENV_MODEL, "gpt-5.5")
        monkeypatch.setenv(ENV_EFFORT, "high")

        reviewer, why = resolve_reviewer(spec_dir, "claude")

        assert reviewer == Reviewer("openai", "gpt-5.5", "high")
        assert why == ""

    @pytest.mark.parametrize("build", ["claude", "anthropic", "Claude"])
    def test_the_builds_own_provider_is_refused(self, spec_dir, monkeypatch, build):
        monkeypatch.setenv(ENV_PROVIDER, "anthropic")
        monkeypatch.setenv(ENV_MODEL, "claude-opus-4-8")

        reviewer, why = resolve_reviewer(spec_dir, build)

        assert reviewer is None
        assert "another one" in why

    def test_a_provider_without_a_model_is_refused(self, spec_dir, monkeypatch):
        monkeypatch.setenv(ENV_PROVIDER, "openai")
        reviewer, why = resolve_reviewer(spec_dir, "claude")
        assert reviewer is None
        assert "no model" in why

    def test_the_task_overrides_or_turns_off_the_project(self, spec_dir, monkeypatch):
        monkeypatch.setenv(ENV_PROVIDER, "openai")
        monkeypatch.setenv(ENV_MODEL, "gpt-5.5")
        metadata = spec_dir / "task_metadata.json"

        metadata.write_text(
            json.dumps({"crossReview": {"provider": "mistral", "model": "devstral"}}),
            encoding="utf-8",
        )
        assert resolve_reviewer(spec_dir, "claude")[0] == Reviewer(
            "mistral", "devstral"
        )

        metadata.write_text(
            json.dumps({"crossReview": {"enabled": False}}), encoding="utf-8"
        )
        assert resolve_reviewer(spec_dir, "claude") == (
            None,
            "turned off for this task",
        )

    def test_a_name_that_is_not_one_is_ignored(self, spec_dir, monkeypatch):
        monkeypatch.setenv(ENV_PROVIDER, "openai; rm -rf ~")
        monkeypatch.setenv(ENV_MODEL, "gpt-5.5")
        assert resolve_reviewer(spec_dir, "claude")[0] is None


class TestReadingTheAnswer:
    def test_agree(self):
        verdict = parse_verdict(_answer(verdict="agree", summary="Fine.", findings=[]))
        assert verdict.verdict == "agree"

    def test_a_disagreement_names_a_blocker(self):
        verdict = parse_verdict(
            _answer(verdict="disagree", summary="Missing route.", findings=[BLOCKER])
        )
        assert verdict.verdict == "disagree"
        assert verdict.blocking()[0]["line"] == 42

    @pytest.mark.parametrize(
        "text",
        [
            None,
            "",
            "Looks good to me!",
            '{"verdict": "agree"',  # cut off
            _answer(verdict="approve", findings=[]),
            _answer(verdict="disagree", findings=[{**BLOCKER, "severity": "minor"}]),
            _answer(verdict="disagree", findings=[]),
            _answer(verdict="agree", findings=[BLOCKER]),
        ],
    )
    def test_anything_unclear_is_inconclusive_never_agree(self, text):
        verdict = parse_verdict(text)
        assert verdict.verdict == "inconclusive"
        assert verdict.note

    def test_the_last_verdict_is_the_answer(self):
        text = (
            _answer(verdict="agree", findings=[])
            + "Wait, I missed something.\n"
            + _answer(verdict="disagree", findings=[BLOCKER])
        )
        assert parse_verdict(text).verdict == "disagree"

    def test_findings_are_bounded_and_normalised(self):
        noisy = [{"severity": "CRITICAL", "issue": "x" * 2000, "line": -3}] * 50
        verdict = parse_verdict(_answer(verdict="agree", findings=noisy))
        assert len(verdict.findings) == 20
        assert verdict.findings[0]["severity"] == "minor"
        assert verdict.findings[0]["line"] is None
        assert len(verdict.findings[0]["issue"]) == 500


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout


class TestWhatWasReviewed:
    def test_a_commit_of_the_same_content_keeps_the_fingerprint(self, temp_git_repo):
        (temp_git_repo / "orders.py").write_text(
            "def delete(): ...\n", encoding="utf-8"
        )
        before = tree_fingerprint(temp_git_repo)
        status_before = _git(temp_git_repo, "status", "--porcelain")

        _git(temp_git_repo, "add", "-A")
        _git(temp_git_repo, "commit", "-qm", "orders")

        assert before is not None
        assert tree_fingerprint(temp_git_repo) == before
        assert status_before == "?? orders.py\n", "the real index is untouched"

    def test_an_edit_changes_it(self, temp_git_repo):
        before = tree_fingerprint(temp_git_repo)
        (temp_git_repo / "orders.py").write_text(
            "def delete(): ...\n", encoding="utf-8"
        )
        assert tree_fingerprint(temp_git_repo) != before

    def test_workpilot_files_and_ignored_files_do_not(self, temp_git_repo):
        (temp_git_repo / ".gitignore").write_text("build/\n", encoding="utf-8")
        _git(temp_git_repo, "add", "-A")
        _git(temp_git_repo, "commit", "-qm", "ignore")
        before = tree_fingerprint(temp_git_repo)

        (temp_git_repo / ".workpilot-discard-list").write_text(
            "src/a.py\n", encoding="utf-8"
        )
        (temp_git_repo / "build").mkdir()
        (temp_git_repo / "build" / "out.bin").write_text("x", encoding="utf-8")

        assert tree_fingerprint(temp_git_repo) == before

    def test_not_a_repository_has_no_fingerprint(self, tmp_path):
        assert tree_fingerprint(tmp_path) is None


def _record(spec_dir, worktree, verdict, *, at=None, tree=None):
    reviewer = Reviewer("openai", "gpt-5.5")
    findings = [BLOCKER] if verdict == "disagree" else []
    record = write_verdict(
        spec_dir,
        Verdict(verdict, "s", findings),
        reviewer,
        tree if tree is not None else tree_fingerprint(worktree),
        "claude",
    )
    if at:
        record["at"] = at
        (spec_dir / VERDICT_FILE).write_text(json.dumps(record), encoding="utf-8")
    return record


class TestOnlyACurrentDisagreementBlocks:
    def test_a_disagreement_about_this_code_blocks(self, temp_git_repo, spec_dir):
        _record(spec_dir, temp_git_repo, "disagree")
        held = blocking_verdict([spec_dir], temp_git_repo)
        assert held is not None and held["provider"] == "openai"

    @pytest.mark.parametrize("verdict", ["agree", "inconclusive"])
    def test_nothing_else_blocks(self, temp_git_repo, spec_dir, verdict):
        _record(spec_dir, temp_git_repo, verdict)
        assert blocking_verdict([spec_dir], temp_git_repo) is None

    def test_a_disagreement_about_older_code_is_stale(self, temp_git_repo, spec_dir):
        _record(spec_dir, temp_git_repo, "disagree")
        (temp_git_repo / "orders.py").write_text(
            "def delete(): return 204\n", encoding="utf-8"
        )
        assert blocking_verdict([spec_dir], temp_git_repo) is None

    def test_an_unknown_tree_blocks_nothing(self, temp_git_repo, spec_dir):
        _record(spec_dir, temp_git_repo, "disagree", tree="")
        assert blocking_verdict([spec_dir], temp_git_repo) is None

    def test_the_newest_record_decides(self, temp_git_repo, spec_dir, tmp_path):
        other = tmp_path / "worktree-copy"
        other.mkdir()
        _record(spec_dir, temp_git_repo, "disagree", at="2026-10-30T10:00:00+00:00")
        _record(other, temp_git_repo, "agree", at="2026-10-30T11:00:00+00:00")
        assert blocking_verdict([spec_dir, other], temp_git_repo) is None

    def test_an_unreadable_record_is_no_record(self, temp_git_repo, spec_dir):
        (spec_dir / VERDICT_FILE).write_text("{oops", encoding="utf-8")
        assert read_verdict(spec_dir) is None
        assert blocking_verdict([spec_dir], temp_git_repo) is None


class TestThePullRequestIsHeldBack:
    @pytest.fixture
    def manager(self, temp_git_repo, monkeypatch):
        manager = WorktreeManager(temp_git_repo)
        manager.setup()
        info = manager.create_worktree("004-orders")
        (info.path / "orders.py").write_text("def delete(): ...\n", encoding="utf-8")
        manager.commit_in_worktree("004-orders", "feat: orders")
        pushed = []
        monkeypatch.setattr(
            manager,
            "push_branch",
            lambda *a, **k: pushed.append(a) or {"success": False, "error": "offline"},
        )
        manager.pushed = pushed
        return manager

    def _disagree(self, manager):
        spec = manager.project_dir / ".workpilot" / "specs" / "004-orders"
        spec.mkdir(parents=True, exist_ok=True)
        _record(spec, manager.get_worktree_path("004-orders"), "disagree")

    def test_a_disagreement_stops_it_before_the_push(self, manager):
        self._disagree(manager)

        result = manager.push_and_create_pr("004-orders", manager.base_branch)

        assert result["success"] is False
        assert result["cross_review_blocked"] is True
        assert "OrdersController.cs:42" in result["error"]
        assert manager.pushed == []

    def test_the_persons_override_lets_it_through(self, manager):
        self._disagree(manager)

        result = manager.push_and_create_pr(
            "004-orders", manager.base_branch, allow_cross_review_disagreement=True
        )

        assert not result.get("cross_review_blocked")
        assert len(manager.pushed) == 1

    def test_without_a_review_nothing_changes(self, manager):
        result = manager.push_and_create_pr("004-orders", manager.base_branch)
        assert not result.get("cross_review_blocked")
        assert len(manager.pushed) == 1

    def test_the_cli_carries_the_override(self):
        from cli.main import parse_args

        argv = ["--spec", "004", "--create-pr", "--pr-ignore-cross-review"]
        assert parse_args(argv).pr_ignore_cross_review is True


class TestThePhase:
    @pytest.fixture
    def ctx(self, temp_git_repo, spec_dir, tmp_path):
        source = tmp_path / "main-spec" / spec_dir.name
        source.mkdir(parents=True)
        return SimpleNamespace(
            project_dir=temp_git_repo,
            spec_dir=spec_dir,
            source_spec_dir=source,
            changed_files=["orders.py"],
            verbose=False,
        )

    @pytest.fixture
    def resolved(self):
        phase = SimpleNamespace(id="cross-review", impl="tooling/review-lenses")
        return SimpleNamespace(phase=phase, dispatch="fresh-context")

    def _run(self, resolved, ctx):
        return asyncio.run(cross_phase.run_cross_review_phase(resolved, ctx))

    def test_unconfigured_it_opens_no_session(self, resolved, ctx, monkeypatch):
        async def boom(*_a, **_k):
            raise AssertionError("no session without a second engine")

        monkeypatch.setattr(cross_phase, "_session", boom)

        outcome = self._run(resolved, ctx)

        assert outcome.succeeded is None
        assert outcome.detail == "skipped: no second engine configured"
        assert not (ctx.spec_dir / VERDICT_FILE).exists()

    def test_a_disagreement_is_recorded_where_the_card_and_the_pr_read_it(
        self, resolved, ctx, monkeypatch
    ):
        monkeypatch.setenv(ENV_PROVIDER, "openai")
        monkeypatch.setenv(ENV_MODEL, "gpt-5.5")
        prompts = []

        async def session(_ctx, reviewer, prompt):
            prompts.append((reviewer, prompt))
            return "complete", _answer(verdict="disagree", findings=[BLOCKER])

        monkeypatch.setattr(cross_phase, "_session", session)

        outcome = self._run(resolved, ctx)

        assert outcome.succeeded is False
        assert "held back" in outcome.detail
        for directory in (ctx.spec_dir, ctx.source_spec_dir):
            record = read_verdict(directory)
            assert record["verdict"] == "disagree"
            assert record["provider"] == "openai"
            assert record["tree"] == tree_fingerprint(ctx.project_dir)
        reviewer, prompt = prompts[0]
        assert reviewer.model == "gpt-5.5"
        assert "spec.md" in prompt and '"verdict"' in prompt

    def test_the_card_reads_a_summary_in_the_plan(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(ENV_PROVIDER, "openai")
        monkeypatch.setenv(ENV_MODEL, "gpt-5.5")
        plan_path = ctx.source_spec_dir / "implementation_plan.json"
        plan_path.write_text(
            json.dumps({"feature": "Orders", "phases": []}), encoding="utf-8"
        )

        async def session(*_a):
            return "complete", _answer(
                verdict="disagree", summary="Missing route.", findings=[BLOCKER]
            )

        monkeypatch.setattr(cross_phase, "_session", session)

        self._run(resolved, ctx)

        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        assert plan["feature"] == "Orders", "merged, never replaced"
        assert plan["crossReview"]["verdict"] == "disagree"
        assert plan["crossReview"]["blockers"] == 1
        assert plan["crossReview"]["provider"] == "openai"

    def test_a_failed_session_is_inconclusive(self, resolved, ctx, monkeypatch):
        monkeypatch.setenv(ENV_PROVIDER, "openai")
        monkeypatch.setenv(ENV_MODEL, "gpt-5.5")

        async def session(*_a):
            raise RuntimeError("401 invalid key")

        monkeypatch.setattr(cross_phase, "_session", session)

        outcome = self._run(resolved, ctx)

        assert outcome.succeeded is None
        assert outcome.detail.startswith("inconclusive")
        assert read_verdict(ctx.source_spec_dir)["verdict"] == "inconclusive"
        assert blocking_verdict([ctx.source_spec_dir], ctx.project_dir) is None
