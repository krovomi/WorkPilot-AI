"""
Bounty Board — unit tests.

The suite this replaces had a test named
`test_default_judge_ranks_longer_more_relevant_output_higher`, which asserted
that a contestant whose answer was `"must " * 200` beat one whose answer was
`"must"`. That was the bug, written down as the specification: the board was
scoring the length of the prose. Every test also injected a fake runner, so the
real one — whose `from llm_client import acomplete` raised `ImportError` on
every single run and fell through to a stub — was never once executed here.

So this suite is organised around what actually has to hold:

* the judge scores the **change**, and says so when it cannot measure one;
* an absent signal is renormalised, never scored as zero;
* no criterion is a rank, so a millisecond cannot cost ten points;
* the default runner reaches a real provider, and fails loudly when it cannot.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from bounty_board import (  # noqa: E402
    BountyBoard,
    Contestant,
    ContestantSpec,
    run_bounty,
)
from bounty_board.judge import (  # noqa: E402
    WEIGHT_EFFICIENCY,
    WEIGHT_SPEC_FIT,
    WEIGHT_TESTS,
    SpecFitRating,
    _parse_ratings,
    evidence_judge,
    score_contestant,
)
from bounty_board.runner import contestant_prompt  # noqa: E402
from bounty_board.signals import (  # noqa: E402
    DiffEvidence,
    Evidence,
    TestEvidence,
    _parse_test_counts,
    collect_diff,
    collect_evidence,
    run_tests,
)

# ─── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture()
def spec_dir(tmp_path: Path) -> Path:
    spec = tmp_path / "specs" / "001-demo"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text(
        "# Demo spec\n\n"
        "- FR-001 The system must emit a hello message.\n"
        "- FR-002 Tests should pass.\n",
        encoding="utf-8",
    )
    return spec


@pytest.fixture()
def project_path(tmp_path: Path) -> Path:
    return tmp_path


def _contestant(
    label: str = "A",
    *,
    status: str = "completed",
    duration_ms: int = 1000,
    cost_usd: float = 0.0,
    error: str | None = None,
) -> Contestant:
    return Contestant(
        id=f"c-{label}",
        label=label,
        provider="provider",
        model="model",
        status=status,
        duration_ms=duration_ms,
        cost_usd=cost_usd,
        error=error,
    )


def _evidence(
    *,
    files_changed: int = 2,
    insertions: int = 20,
    diff_available: bool = True,
    tests_status: str = "passed",
    passed: int = 10,
    failed: int = 0,
) -> Evidence:
    return Evidence(
        diff=DiffEvidence(
            available=diff_available,
            files_changed=files_changed,
            insertions=insertions,
            patch="--- a/x\n+++ b/x\n+change\n" if files_changed else "",
        ),
        tests=TestEvidence(status=tests_status, passed=passed, failed=failed),
    )


def _make_runner(outputs: dict[str, str], fail: set[str] | None = None):
    """A fake contestant runner that also writes a file, so there is a diff."""
    fail = fail or set()

    async def _runner(contestant: Contestant, spec_prompt: str, worktree: Path) -> None:
        assert spec_prompt
        assert worktree.exists()
        if contestant.label in fail:
            contestant.status = "error"
            contestant.error = "forced failure"
            return
        text = outputs.get(contestant.label, "")
        (worktree / f"entry_{contestant.label}.txt").write_text(text, encoding="utf-8")
        contestant.status = "completed"
        contestant.output = text
        contestant.tokens_used = len(text) // 4
        contestant.duration_ms = 10

    return _runner


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    )


@pytest.fixture()
def git_project(tmp_path: Path) -> Path:
    """A minimal real git repository, so diffs can actually be measured."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(["init", "-b", "main"], repo)
    _git(["config", "user.email", "test@example.com"], repo)
    _git(["config", "user.name", "Test"], repo)
    (repo / "README.md").write_text("base\n", encoding="utf-8")
    _git(["add", "."], repo)
    _git(["commit", "-m", "base"], repo)
    return repo


# ─── The bug that was reported ─────────────────────────────────────────────────


def test_a_contestant_that_changed_nothing_scores_zero():
    """The exact shape of the reported run.

    Three contestants, no diff between them, durations 0 / 0 / 1 ms. The old
    board scored them 77.9 / 77.8 / 67.9 and crowned one. Producing nothing is
    producing nothing.
    """
    evidence = Evidence(
        diff=DiffEvidence(available=True), tests=TestEvidence(status="no-change")
    )
    for label, duration in (("A", 0), ("B", 0), ("C", 1)):
        verdict = score_contestant(
            _contestant(label, duration_ms=duration), evidence, None, 0.0, 0.0
        )
        assert verdict.score == 0.0
        assert verdict.disqualified_reason == "produced no change"


def test_one_millisecond_does_not_cost_ten_points():
    """The old `latency = 10 * (1 - duration/slowest)` gave the slowest exactly
    zero whatever the gap. A photo finish must score as a photo finish."""
    evidence = _evidence()
    fastest = score_contestant(
        _contestant("A", duration_ms=0), evidence, None, 0.0, 0.0
    )
    slowest = score_contestant(
        _contestant("C", duration_ms=1), evidence, None, 0.0, 0.0
    )
    assert fastest.score - slowest.score < 0.1
    assert slowest.score > 99.0


def test_efficiency_is_a_ratio_to_the_best_not_a_rank():
    """Being last is not being worthless; being twice as slow is being half as
    efficient, and the field's size must not change anyone's score."""
    evidence = _evidence()
    fast = score_contestant(
        _contestant("A", duration_ms=10_000), evidence, None, 10_000.0, 0.0
    )
    slow = score_contestant(
        _contestant("B", duration_ms=120_000), evidence, None, 10_000.0, 0.0
    )
    assert fast.score > slow.score
    # The slowest still keeps everything it earned on the criteria that matter.
    assert slow.score > 85.0


def test_score_is_not_decided_by_output_length():
    """A long answer and a short one, same measured change, same score."""
    evidence = _evidence()
    short = _contestant("A")
    short.output = "done"
    verbose = _contestant("B")
    verbose.output = "I have carefully considered every option. " * 200
    assert (
        score_contestant(short, evidence, None, 1000.0, 0.0).score
        == score_contestant(verbose, evidence, None, 1000.0, 0.0).score
    )


# ─── Renormalisation: absent evidence is not a zero ────────────────────────────


def test_missing_test_command_redistributes_its_weight():
    """A project with no test suite has not failed its tests."""
    evidence = _evidence(tests_status="no-command")
    verdict = score_contestant(
        _contestant(), evidence, SpecFitRating(1.0, "fully satisfies"), 1000.0, 0.0
    )
    tests = next(c for c in verdict.criteria if c.name == "tests")
    assert tests.value is None
    assert verdict.breakdown()["tests"] is None
    # spec_fit was perfect and efficiency is at its best, so the renormalised
    # score is full marks — not 100 * 35/(35+10+55).
    assert verdict.score == pytest.approx(100.0, abs=0.01)


def test_failing_tests_are_a_real_zero_not_a_missing_signal():
    """Same contestant, same spec-fit rating: the one whose suite actually
    failed must score below the one whose suite was never run."""
    rating = SpecFitRating(0.5, "partially satisfies")
    failing = score_contestant(
        _contestant(),
        _evidence(tests_status="failed", passed=0, failed=3),
        rating,
        1000.0,
        0.0,
    )
    absent = score_contestant(
        _contestant(), _evidence(tests_status="no-command"), rating, 1000.0, 0.0
    )
    assert failing.score < absent.score
    assert next(c for c in failing.criteria if c.name == "tests").value == 0.0
    assert next(c for c in absent.criteria if c.name == "tests").value is None


def test_efficiency_alone_never_produces_a_score():
    """A contestant can be quick and worthless. Speed is a tiebreaker between
    entries that were measured on something, never a verdict of its own."""
    verdict = score_contestant(
        _contestant(duration_ms=1),
        _evidence(tests_status="no-command"),
        None,
        1000.0,
        0.0,
    )
    assert verdict.score == 0.0
    assert verdict.disqualified_reason == "no signal could be measured"


@pytest.mark.parametrize(
    "status", ["timeout", "error", "skipped", "no-command", "no-change"]
)
def test_inconclusive_test_runs_are_never_read_as_a_failure(status: str):
    evidence = _evidence(tests_status=status)
    verdict = score_contestant(_contestant(), evidence, None, 1000.0, 0.0)
    tests = next(c for c in verdict.criteria if c.name == "tests")
    assert tests.value is None, f"{status} must not score as a failure"


def test_nothing_measurable_is_reported_rather_than_scored():
    """No diff signal, no tests, no judge: the board says it could not tell."""
    evidence = Evidence(
        diff=DiffEvidence(available=False, unavailable_reason="not a git worktree"),
        tests=TestEvidence(status="no-command"),
    )
    verdict = score_contestant(_contestant(), evidence, None, 0.0, 0.0)
    assert verdict.score == 0.0
    assert verdict.disqualified_reason == "no signal could be measured"


def test_weights_are_ratios_and_a_full_board_totals_one_hundred():
    verdict = score_contestant(
        _contestant(duration_ms=1000),
        _evidence(),
        SpecFitRating(1.0, "ok"),
        1000.0,
        0.0,
    )
    assert verdict.score == pytest.approx(100.0, abs=0.01)
    assert WEIGHT_TESTS + WEIGHT_SPEC_FIT + WEIGHT_EFFICIENCY == 100.0


# ─── The judge as a whole ──────────────────────────────────────────────────────


def _judge(contestants, evidences, spec="spec", project=Path("."), spec_dir=Path(".")):
    return asyncio.run(
        evidence_judge(
            contestants, evidences, spec, project, spec_dir, use_model_judge=False
        )
    )


def test_passing_tests_beat_a_bigger_diff_that_fails():
    good, bad = (
        _contestant("A", duration_ms=30_000),
        _contestant("B", duration_ms=20_000),
    )
    winner_id, rationale = _judge(
        [good, bad],
        {
            good.id: _evidence(files_changed=1, insertions=8, tests_status="passed"),
            bad.id: _evidence(
                files_changed=40, insertions=2000, tests_status="failed", failed=9
            ),
        },
    )
    assert winner_id == good.id
    assert "suite passed" in rationale[good.id]
    assert "suite failed" in rationale[bad.id]


def test_errored_contestants_do_not_win():
    ok = _contestant("A")
    broken = _contestant("B", status="error", error="provider refused the request")
    winner_id, rationale = _judge(
        [broken, ok], {ok.id: _evidence(), broken.id: Evidence()}
    )
    assert winner_id == ok.id
    assert broken.score == 0.0
    assert "provider refused" in rationale[broken.id]


def test_a_tie_is_reported_as_a_tie_not_given_to_the_first_declared():
    """Stable-sorting a tie handed the trophy to whoever was declared first.
    At the 0.1-point margins the old board produced, that was most runs."""
    a, b = _contestant("A", duration_ms=5000), _contestant("B", duration_ms=5000)
    winner_id, rationale = _judge([a, b], {a.id: _evidence(), b.id: _evidence()})
    assert winner_id == ""
    assert a.score == b.score
    assert "tied" in rationale[a.id] and "tied" in rationale[b.id]


def test_judge_records_the_evidence_on_each_contestant():
    """The card must be able to show what was measured, not only the number."""
    c = _contestant()
    _judge([c], {c.id: _evidence(files_changed=3, insertions=42, passed=17)})
    assert c.evidence["diff"]["files_changed"] == 3
    assert c.evidence["tests"]["status"] == "passed"
    # The patch is the judge's input and can be megabytes; it must not be
    # written into the archive the Kanban reads back.
    assert "patch" not in c.evidence["diff"]


def test_spec_fit_ratings_survive_a_fenced_or_prefixed_answer():
    parsed = _parse_ratings(
        'Here are my ratings:\n```json\n{"ratings": '
        '[{"candidate": 1, "score": 0.9, "reason": "covers FR-001"}]}\n```',
        expected=2,
    )
    assert parsed[1].value == pytest.approx(0.9)
    assert "FR-001" in parsed[1].detail


def test_spec_fit_ratings_are_clamped_and_out_of_range_candidates_dropped():
    parsed = _parse_ratings(
        '{"ratings": [{"candidate": 1, "score": 4.2}, {"candidate": 9, "score": 1.0}]}',
        expected=1,
    )
    assert parsed[1].value == 1.0
    assert 9 not in parsed


# ─── Signals ───────────────────────────────────────────────────────────────────


def test_a_newly_created_file_counts_as_a_change(git_project: Path):
    """Without `git add -N` a contestant that only creates files reads as an
    empty diff — the single worst way this board could be unfair."""
    (git_project / "new_feature.py").write_text("print('hi')\n", encoding="utf-8")
    diff = collect_diff(git_project, "HEAD")
    assert diff.available
    assert not diff.is_empty
    assert diff.files_changed == 1
    assert "new_feature.py" in diff.patch


def test_an_untouched_worktree_is_an_empty_diff(git_project: Path):
    diff = collect_diff(git_project, "HEAD")
    assert diff.available
    assert diff.is_empty


def test_diff_on_a_non_git_directory_is_unavailable_not_empty(tmp_path: Path):
    """Unavailable and empty must stay distinct: one is 'we cannot tell', the
    other is 'the contestant did nothing'."""
    diff = collect_diff(tmp_path, "HEAD")
    assert not diff.available
    assert diff.unavailable_reason


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("=== 5 passed, 2 failed in 1.2s ===", (5, 2)),
        ("Tests  3 failed | 12 passed (15)", (12, 3)),
        ("Passed! - Failed: 0, Passed: 12, Skipped: 1", (12, 0)),
        ("no recognisable counts here", (0, 0)),
    ],
)
def test_test_count_parsing(output: str, expected: tuple[int, int]):
    assert _parse_test_counts(output) == expected


def test_unrecognised_test_output_does_not_become_a_failure():
    """The exit code is the verdict; the counts are for the reader. A suite
    whose format nobody here recognises must not read as '0 passed'."""
    evidence = _evidence(tests_status="passed", passed=0, failed=0)
    verdict = score_contestant(_contestant(), evidence, None, 1000.0, 0.0)
    tests = next(c for c in verdict.criteria if c.name == "tests")
    assert tests.value == 1.0


# These four assert POSIX shell semantics (`&&`, `$VAR`, `sleep`), which is the
# thing under test: `discover_test_command` hands back a CI `run:` block, and a
# block is a shell script. cmd.exe would need different scripts to assert the
# same behaviour, and writing them here would test our idea of cmd.exe rather
# than the contract. The code path itself is exercised on Windows by the
# orchestration tests.
posix_shell = pytest.mark.skipif(
    os.name == "nt", reason="asserts POSIX shell syntax; cmd.exe is a different script"
)


@posix_shell
def test_run_tests_reads_the_exit_code_as_the_verdict(tmp_path: Path):
    """The project's own command decides; the parsed counts are for the reader.
    A suite whose output nobody here recognises must not read as a failure."""
    passing = asyncio.run(run_tests(tmp_path, "echo 'nothing recognisable'"))
    assert passing.status == "passed"
    assert passing.exit_code == 0
    assert (passing.passed, passing.failed) == (0, 0)

    failing = asyncio.run(run_tests(tmp_path, "echo '1 failed' && exit 1"))
    assert failing.status == "failed"
    assert failing.failed == 1


@posix_shell
def test_run_tests_executes_a_multi_line_ci_block(tmp_path: Path):
    """`discover_test_command` returns a CI `run:` block, which is a shell
    script and not an argv list — in this repository it is `source …/activate`
    followed by `pytest`. Splitting it into arguments would measure nothing."""
    evidence = asyncio.run(run_tests(tmp_path, 'VALUE=7\necho "got $VALUE"'))
    assert evidence.status == "passed"
    assert "got 7" in evidence.output_tail


@posix_shell
def test_run_tests_times_out_without_hanging_the_board(tmp_path: Path):
    """A timeout is 'we do not know', not a contestant failing."""
    evidence = asyncio.run(run_tests(tmp_path, "sleep 30", timeout_s=1))
    assert evidence.status == "timeout"
    assert not evidence.conclusive


@posix_shell
def test_run_tests_is_not_given_the_boards_own_provider(tmp_path: Path):
    """A contestant's suite reading SELECTED_LLM_PROVIDER would see the judge's
    configuration rather than the project's."""
    os.environ["SELECTED_LLM_PROVIDER"] = "anthropic"
    try:
        evidence = asyncio.run(run_tests(tmp_path, 'echo "[$SELECTED_LLM_PROVIDER]"'))
    finally:
        os.environ.pop("SELECTED_LLM_PROVIDER", None)
    assert "[]" in evidence.output_tail


def test_no_suite_is_run_against_an_empty_diff(git_project: Path):
    """Running it would measure the base branch and hand every do-nothing
    contestant a clean pass."""
    evidence = asyncio.run(
        collect_evidence(git_project, "HEAD", "exit 1", run_test_suite=True)
    )
    assert evidence.diff.is_empty
    assert evidence.tests.status == "no-change"
    assert not evidence.tests.conclusive


# ─── The runner ────────────────────────────────────────────────────────────────


def test_prompt_override_reaches_the_prompt():
    """It was parsed from the CLI, stored on ContestantSpec, and then dropped
    by `_materialize`: the per-entry strategy reached no model."""
    c = _contestant()
    c.prompt_override = "Prioritize readability over cleverness."
    prompt = contestant_prompt(c, "Build a widget.")
    assert "Prioritize readability" in prompt
    # An override adds to the brief; it never replaces it.
    assert "Build a widget." in prompt


def test_prompt_never_names_the_contestants_own_model():
    """The old header embedded `provider:model` in the prompt, which is how the
    stub's output — and therefore the score — ended up varying with the length
    of the model's name."""
    c = _contestant()
    c.provider, c.model = "anthropic", "claude-sonnet-4-6"
    prompt = contestant_prompt(c, "Build a widget.")
    assert "claude-sonnet-4-6" not in prompt
    assert "anthropic" not in prompt


def test_default_runner_fails_loudly_when_no_provider_can_be_reached(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The replaced runner answered an unreachable provider with a stub string
    that scored like a real entry. Failure must be visible."""
    import types

    import bounty_board.runner as runner_module

    # Stand in for `core.client` and `agents.session` rather than importing the
    # whole backend: this asserts what the runner does when client creation
    # fails, which must not depend on the app's dependency tree being present.
    fake_client = types.ModuleType("core.client")

    def _explode(**_kwargs):
        raise RuntimeError("no credentials for provider")

    fake_client.create_agent_client = _explode
    fake_session = types.ModuleType("agents.session")
    fake_session.run_agent_session = None
    monkeypatch.setitem(sys.modules, "core.client", fake_client)
    monkeypatch.setitem(sys.modules, "agents.session", fake_session)

    c = _contestant(status="queued")
    c.spec_dir = str(tmp_path)
    asyncio.run(runner_module.default_contestant_runner(c, "spec", tmp_path))

    assert c.status == "error"
    assert "no credentials" in (c.error or "")
    assert c.output == ""
    assert c.completed_at is not None


def test_default_runner_reports_a_failed_agent_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A session that comes back `error` is an errored contestant, not a
    completed one holding an error message as its answer."""
    import types

    import bounty_board.runner as runner_module

    class _Client:
        last_usage = {"input_tokens": 10, "output_tokens": 5, "cost_usd": 0.02}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    fake_client = types.ModuleType("core.client")
    fake_client.create_agent_client = lambda **_kw: _Client()
    fake_session = types.ModuleType("agents.session")

    async def _session(_client, _prompt, _spec_dir):
        return "error", "", {"message": "context window exceeded"}

    fake_session.run_agent_session = _session
    monkeypatch.setitem(sys.modules, "core.client", fake_client)
    monkeypatch.setitem(sys.modules, "agents.session", fake_session)

    c = _contestant(status="queued")
    c.spec_dir = str(tmp_path)
    asyncio.run(runner_module.default_contestant_runner(c, "spec", tmp_path))

    assert c.status == "error"
    assert "context window exceeded" in (c.error or "")
    # Usage still reported: the call was billed whether or not it succeeded.
    assert c.tokens_used == 15
    assert c.cost_usd == pytest.approx(0.02)


def test_no_module_in_the_package_imports_a_nonexistent_llm_client():
    """Regression guard for the defect this whole change is about: the runner
    imported `llm_client`, which resolves to nothing on the runner's path, and
    the ImportError handler quietly produced a scoreable stub.

    Parsed rather than grepped, so that the modules may keep *describing* the
    defect in their docstrings — which is most of how anyone will understand
    why this guard exists.
    """
    import ast

    for path in (BACKEND / "bounty_board").glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

        # Docstrings are prose about the defect, not the defect.
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(
                node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
            ):
                first = next(iter(getattr(node, "body", [])), None)
                if (
                    isinstance(first, ast.Expr)
                    and isinstance(first.value, ast.Constant)
                    and isinstance(first.value.value, str)
                ):
                    docstrings.add(id(first.value))

        for node in ast.walk(tree):
            if id(node) in docstrings:
                continue
            if isinstance(node, ast.ImportFrom):
                assert node.module != "llm_client", f"{path.name}:{node.lineno}"
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name != "llm_client", f"{path.name}:{node.lineno}"
            # A literal that formats a fake answer is the other half of the bug.
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                assert "[stub:" not in node.value, f"{path.name}:{node.lineno}"
            elif isinstance(node, ast.JoinedStr):
                rendered = "".join(
                    part.value
                    for part in node.values
                    if isinstance(part, ast.Constant) and isinstance(part.value, str)
                )
                assert "[stub:" not in rendered, f"{path.name}:{node.lineno}"


# ─── Orchestration ─────────────────────────────────────────────────────────────


def test_bounty_runs_all_contestants_in_parallel(spec_dir, project_path):
    contestants = [
        ContestantSpec(provider="anthropic", model="claude-sonnet-4-6"),
        ContestantSpec(provider="openai", model="gpt-4o"),
        ContestantSpec(provider="ollama", model="llama3.3"),
    ]
    board = BountyBoard(
        spec_dir=spec_dir,
        project_path=project_path,
        contestants=contestants,
        runner=_make_runner({"A": "alpha", "B": "beta", "C": "gamma"}),
        run_tests=False,
        use_model_judge=False,
    )
    result = asyncio.run(board.run())

    assert result.status == "completed"
    assert len(result.contestants) == 3
    assert all(
        c.worktree_path and Path(c.worktree_path).exists() for c in result.contestants
    )
    assert all(c.score is not None for c in result.contestants)


def test_a_board_with_no_measurable_signal_declares_no_winner(spec_dir, project_path):
    """A non-git project, no test command and no model judge: there is nothing
    to measure, so there is nothing to crown. The old board crowned someone."""
    result = asyncio.run(
        run_bounty(
            spec_dir,
            project_path,
            [
                ContestantSpec(provider="anthropic", model="claude-sonnet-4-6"),
                ContestantSpec(provider="openai", model="gpt-4o"),
            ],
            runner=_make_runner({"A": "short", "B": "much longer answer " * 50}),
            run_tests=False,
            use_model_judge=False,
        )
    )
    assert result.winner_id is None
    assert all(c.score == 0.0 for c in result.contestants)
    assert any("not a git repository" in w for w in result.warnings)


def test_warnings_explain_every_dropped_signal(spec_dir, project_path):
    result = asyncio.run(
        run_bounty(
            spec_dir,
            project_path,
            [ContestantSpec(provider="anthropic", model="claude-haiku-4-6")],
            runner=_make_runner({"A": "x"}),
            run_tests=True,
            use_model_judge=False,
        )
    )
    assert any("No test command" in w for w in result.warnings)
    assert "Warnings" in result.judge_report


def test_a_crashing_runner_does_not_take_the_board_down(spec_dir, project_path):
    async def _boom(contestant, spec_prompt, worktree):
        if contestant.label == "A":
            raise RuntimeError("runner exploded")
        contestant.status = "completed"
        contestant.duration_ms = 5

    result = asyncio.run(
        run_bounty(
            spec_dir,
            project_path,
            [
                ContestantSpec(provider="p", model="m", label="A"),
                ContestantSpec(provider="p", model="m", label="B"),
            ],
            runner=_boom,
            run_tests=False,
            use_model_judge=False,
        )
    )
    a = next(c for c in result.contestants if c.label == "A")
    assert a.status == "error"
    assert "runner exploded" in (a.error or "")
    assert len(result.contestants) == 2


def test_bounty_provider_agnostic_mix(spec_dir, project_path):
    """Orchestrator accepts any (provider, model) — no provider-specific path."""
    pairs = [
        ("anthropic", "claude-sonnet-4-6"),
        ("openai", "gpt-4o"),
        ("google", "gemini-2.5-pro"),
        ("grok", "grok-2"),
        ("ollama", "llama3.3"),
        ("copilot", "gpt-4o"),
        ("windsurf", "swe-1.5"),
    ]
    result = asyncio.run(
        run_bounty(
            spec_dir,
            project_path,
            [ContestantSpec(provider=p, model=m) for p, m in pairs],
            runner=_make_runner(
                {chr(ord("A") + i): f"entry {i}" for i in range(len(pairs))}
            ),
            run_tests=False,
            use_model_judge=False,
        )
    )
    assert {c.provider for c in result.contestants} == {p for p, _ in pairs}


def test_persists_result_to_spec_dir(spec_dir, project_path):
    result = asyncio.run(
        run_bounty(
            spec_dir,
            project_path,
            [ContestantSpec(provider="anthropic", model="claude-haiku-4-6")],
            runner=_make_runner({"A": "entry"}),
            run_tests=False,
            use_model_judge=False,
        )
    )
    files = list((spec_dir / "bounty").glob("*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assert payload["id"] == result.id
    assert payload["status"] == "completed"
    assert "scoring" in payload and "warnings" in payload


def test_empty_contestants_rejected(spec_dir, project_path):
    with pytest.raises(ValueError):
        BountyBoard(spec_dir, project_path, contestants=[])
