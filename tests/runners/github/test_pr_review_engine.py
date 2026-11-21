"""The multi-pass PR review: a quick scan, then the specialised passes side by side.

`PRReviewEngine.run_multi_pass_review` (runners/github/services/pr_review_engine.py)
is what reviews a pull request when the parallel orchestrator is turned off: a
quick scan decides whether the PR needs a deep analysis, then the security,
quality and structural passes run in parallel, with the triage of other AI
tools' comments when there are some. Each pass is a model session; its answer
becomes findings, structural issues or triages, deduplicated across passes.

The model is the stand-in of `tests/review_llm_fake.py`, streaming the
provider-neutral messages every agent client yields; everything else (prompts,
parsing, the learned rules read from the project's files) is the real code.
"""

from __future__ import annotations

import asyncio
import importlib
import json

import pytest
from integrations.jev.models import JevAnswer, JevOutcome
from learning_loop import review_lessons
from runners.github.context_gatherer import AIBotComment, ChangedFile, PRContext
from runners.github.models import (
    AICommentVerdict,
    GitHubRunnerConfig,
    MergeVerdict,
    PRReviewFinding,
    ReviewCategory,
    ReviewPass,
    ReviewSeverity,
)
from runners.github.services.pr_review_engine import ProgressCallback, PRReviewEngine
from runners.github.services.prompt_manager import PromptManager

from tests.review_llm_fake import StandInModel, structured, text

EVIDENCE = "query = 'SELECT * FROM users WHERE id=' + user_id"

SCAN = "Quickly scan this PR"
SECURITY = "You are a security specialist"
QUALITY = "You are a code quality expert"
DEEP = "You are an expert software architect"
STRUCTURAL = "# Structural PR Review Agent"
TRIAGE = "# AI Comment Triage Agent"


def fenced(data) -> str:
    return f"```json\n{json.dumps(data)}\n```"


def finding(title: str, line: int = 3, **extra) -> dict:
    return {
        "title": title,
        "severity": "high",
        "category": "security",
        "file": "app.py",
        "line": line,
        "description": "Built from user input.",
        "evidence": EVIDENCE,
        **extra,
    }


def changed(path: str = "app.py", patch: str = "@@ -1 +1 @@\n-a\n+b") -> ChangedFile:
    return ChangedFile(path, "modified", 3, 1, "", "", patch)


def pr(**overrides) -> PRContext:
    values = {
        "pr_number": 7,
        "title": "Look users up by id",
        "description": "Adds a lookup.",
        "author": "ann",
        "base_branch": "develop",
        "head_branch": "feat/lookup",
        "state": "open",
        "changed_files": [changed()],
        "diff": "@@ -1 +1 @@\n-a\n+b",
        "repo_structure": "",
        "related_files": [],
        "total_additions": 3,
        "total_deletions": 1,
    }
    values.update(overrides)
    return PRContext(**values)


@pytest.fixture
def model(monkeypatch):
    stand_in = StandInModel()
    monkeypatch.setattr(
        importlib.import_module("core.client"), "create_agent_client", stand_in.agent
    )
    return stand_in


@pytest.fixture
def events():
    return []


@pytest.fixture
def engine(tmp_path, events):
    config = GitHubRunnerConfig(
        token="placeholder",  # pragma: allowlist secret
        repo="own/repo",
        use_parallel_orchestrator=False,
    )
    return PRReviewEngine(
        tmp_path, tmp_path / ".workpilot" / "github", config, events.append
    )


def sessions_for(model: StandInModel, marker: str) -> list:
    return [c for c in model.clients if marker in (c.prompt or "")]


def test_a_small_pr_gets_the_three_standing_passes_and_deduplicated_findings(
    engine, model, events
):
    model.answer(text(fenced({"complexity": "low", "risk_areas": []})), when=SCAN)
    model.answer(
        text(fenced([finding("SQL built from input"), finding("Unused import", 9)])),
        when=SECURITY,
    )
    # The same remark from two passes is one finding.
    model.answer(
        text(fenced([finding("SQL built from input ")])),
        structured({"ignored": True}),
        when=QUALITY,
    )
    model.answer(
        text(fenced([{"title": "Unrelated refactor", "severity": "low"}])),
        when=STRUCTURAL,
    )

    findings, issues, triages, scan = asyncio.run(engine.run_multi_pass_review(pr()))

    assert [f.title for f in findings] == ["SQL built from input", "Unused import"]
    assert [i.title for i in issues] == ["Unrelated refactor"]
    assert triages == []
    assert scan == {"complexity": "low", "risk_areas": []}
    assert not sessions_for(model, DEEP) and not sessions_for(model, TRIAGE)
    assert {c.options["agent_type"] for c in model.clients} == {"pr_reviewer"}
    assert all(c.options["model"].startswith("claude-") for c in model.clients)
    assert [e.progress for e in events] == [35, 50, 85]
    assert all(isinstance(e, ProgressCallback) and e.pr_number == 7 for e in events)


def test_a_large_pr_with_ai_comments_adds_the_deep_and_the_triage_passes(engine, model):
    bot = AIBotComment(
        comment_id=41,
        author="coderabbitai[bot]",
        tool_name="CodeRabbit",
        body="This query is injectable.",
        file="app.py",
        line=3,
        created_at="2026-11-01T10:00:00Z",
    )
    general = AIBotComment(42, "cursor[bot]", "Cursor", "Looks fine.", None, None, "t")
    commits = [
        {
            "oid": "abcdef1234",
            "messageHeadline": "Escape the id",
            "committedDate": "2026-11-02",
        }
    ]
    model.answer(text(fenced({"complexity": "low"})), when=SCAN)
    model.answer(text(fenced([finding("Logic hole", line=5)])), when=DEEP)
    model.answer(
        text(
            fenced(
                [
                    {
                        "comment_id": 41,
                        "verdict": "addressed",
                        "tool_name": "CodeRabbit",
                    },
                    {"comment_id": 42, "verdict": "no-such-verdict"},
                ]
            )
        ),
        when=TRIAGE,
    )

    findings, _issues, triages, _scan = asyncio.run(
        engine.run_multi_pass_review(
            pr(total_additions=250, ai_bot_comments=[bot, general], commits=commits)
        )
    )

    assert [f.title for f in findings] == ["Logic hole"]
    assert [(t.comment_id, t.verdict) for t in triages] == [
        (41, AICommentVerdict.ADDRESSED),
        (42, AICommentVerdict.TRIVIAL),
    ]
    triage_prompt = sessions_for(model, TRIAGE)[0].prompt
    assert "### Comment 1: CodeRabbit" in triage_prompt
    assert "- **Line**: 3" in triage_prompt
    assert "- **File**: General" in triage_prompt
    assert "`abcdef12` (2026-11-02): Escape the id" in triage_prompt


@pytest.mark.parametrize(
    ("scan", "additions", "deep"),
    [
        ({"complexity": "low"}, 201, True),
        ({"complexity": "medium"}, 1, True),
        ({"complexity": "high"}, 1, True),
        ({"complexity": "low", "risk_areas": ["auth"]}, 1, True),
        ({"complexity": "low", "risk_areas": []}, 1, False),
        ({}, 1, False),
    ],
)
def test_deep_analysis_is_for_large_complex_or_risky_prs(engine, scan, additions, deep):
    context = pr(total_additions=additions, total_deletions=0)

    assert engine.needs_deep_analysis(scan, context) is deep


def test_a_failed_pass_is_left_out_and_the_others_still_count(engine, model):
    model.answer(text(fenced({"complexity": "low"})), when=SCAN)
    model.answer(ConnectionError("provider went away"), when=SECURITY)
    model.answer(text(fenced([finding("Kept")])), when=QUALITY)
    model.answer(ConnectionError("down"), when=STRUCTURAL)

    findings, issues, _triages, _scan = asyncio.run(engine.run_multi_pass_review(pr()))

    assert [f.title for f in findings] == ["Kept"]
    assert issues == []


def test_a_failing_triage_pass_triages_nothing(engine, model):
    model.answer(text(fenced({"complexity": "low"})), when=SCAN)
    model.answer(ConnectionError("down"), when=TRIAGE)
    bot = AIBotComment(1, "greptile[bot]", "Greptile", "Hm.", None, None, "t")

    *_rest, triages, _scan = asyncio.run(
        engine.run_multi_pass_review(pr(ai_bot_comments=[bot]))
    )

    assert triages == []


def test_a_quick_scan_that_fails_fails_the_review(engine, model):
    model.answer(ConnectionError("no route to the provider"))

    with pytest.raises(RuntimeError, match="Review pass quick_scan failed"):
        asyncio.run(engine.run_multi_pass_review(pr()))


def test_a_quick_scan_without_json_falls_back_to_a_medium_scope(engine, model):
    model.answer(text("I could not decide."))

    scan = asyncio.run(engine.run_review_pass(ReviewPass.QUICK_SCAN, pr()))

    assert scan["complexity"] == "medium"


def test_the_pass_prompt_carries_the_pr_its_commits_and_the_project_rules(
    engine, model, tmp_path
):
    review_lessons.record_plan_feedback(tmp_path, "spec-1", "Never log a token.")
    [lesson] = review_lessons.load_lessons(tmp_path)
    review_lessons.adopt(tmp_path, lesson["id"], "Never log an access token.")
    commits = [{"oid": f"{n:040x}", "messageHeadline": f"step {n}"} for n in range(7)]
    files = [changed(f"src/f{n}.py") for n in range(22)]
    outcome = JevOutcome(
        status="evaluated", answers={"risk": JevAnswer("choice", "low", 0.9)}
    )
    model.answer(text(fenced([])))

    asyncio.run(
        engine.run_review_pass(
            ReviewPass.SECURITY,
            pr(changed_files=files, commits=commits, jev_outcome=outcome),
        )
    )

    prompt = model.prompts[0]
    assert "## Pull Request #7" in prompt and "**Title:** Look users up by id" in prompt
    assert "- ... and 2 more files" in prompt
    assert "`0000000` step 0" in prompt and "- ... and 2 more commits" in prompt
    assert "Optional JEV assessment" in prompt and "- risk: low" in prompt
    assert "Never log an access token." in prompt


def test_a_pr_without_its_full_diff_is_reviewed_from_the_file_patches(engine, model):
    files = [ChangedFile("binary.png", "added", 0, 0, "", "", "")]
    files += [changed(f"f{n}.py", patch=f"+line {n}") for n in range(51)]
    model.answer(text(fenced([])))

    asyncio.run(
        engine.run_review_pass(
            ReviewPass.QUALITY, pr(changed_files=files, diff="", diff_truncated=True)
        )
    )

    prompt = model.prompts[0]
    assert "+line 48" in prompt and "+line 49" not in prompt
    assert "PR has 52 changed files" in prompt


def test_a_pr_too_large_for_one_diff_says_the_review_uses_patches(engine, model):
    model.answer(text(fenced([])))

    asyncio.run(engine.run_review_pass(ReviewPass.QUALITY, pr(diff="")))

    assert "Full PR diff unavailable" in model.prompts[0]


def test_a_very_large_diff_is_cut_and_the_reviewer_is_told(engine, model):
    model.answer(text(fenced([])))

    asyncio.run(engine.run_review_pass(ReviewPass.QUALITY, pr(diff="x" * 60_000)))

    assert "Diff truncated from 60000 to 50,000 characters" in model.prompts[0]


def test_deep_codebase_context_reaches_every_prompt(engine, model):
    deep = {
        "context_available": True,
        "architecture_style": "hexagonal",
        "architecture_layers": [{"name": "domain", "patterns": ["src/domain/*"]}],
    }
    bot = AIBotComment(1, "greptile[bot]", "Greptile", "Hm.", None, None, "t")
    model.answer(text(fenced({"complexity": "low"})), when=SCAN)

    asyncio.run(
        engine.run_multi_pass_review(pr(deep_context=deep, ai_bot_comments=[bot]))
    )

    assert all("**Style:** hexagonal" in p for p in model.prompts)


def test_a_malformed_deep_context_is_left_out_of_the_prompts(engine, model):
    deep = {"context_available": True, "architecture_layers": ["not a layer"]}
    model.answer(text(fenced({"complexity": "low"})), when=SCAN)

    asyncio.run(engine.run_multi_pass_review(pr(deep_context=deep)))

    assert model.prompts and all(
        "Deep Codebase Context" not in p for p in model.prompts
    )


def test_the_structural_and_triage_passes_fall_back_to_the_built_in_prompts(
    engine, model, tmp_path
):
    engine.prompt_manager = PromptManager(prompts_dir=tmp_path / "no-prompts")
    files = [ChangedFile("binary.png", "added", 0, 0, "", "", "")]
    files += [changed(f"f{n}.py") for n in range(30)]
    bot = AIBotComment(1, "greptile[bot]", "Greptile", "Hm.", None, None, "t")
    model.answer(text(fenced({"complexity": "low"})), when=SCAN)

    asyncio.run(
        engine.run_multi_pass_review(
            pr(changed_files=files, ai_bot_comments=[bot], diff="", diff_truncated=True)
        )
    )

    structural = sessions_for(model, "reviewing this PR for STRUCTURAL issues")
    triage = sessions_for(model, "You are triaging comments from other AI")
    assert structural and triage
    assert "- ... and 1 more files" in structural[0].prompt


def test_an_ai_triage_without_ai_comments_asks_nothing(engine, model):
    assert asyncio.run(engine._run_ai_triage_pass(pr())) == "[]"
    assert model.clients == []


def test_a_project_folder_named_backend_is_reviewed_as_it_is(tmp_path, model):
    backend = tmp_path / "apps" / "backend"
    backend.mkdir(parents=True)
    config = GitHubRunnerConfig(
        token="placeholder",  # pragma: allowlist secret
        repo="o/r",
        model="",
        use_parallel_orchestrator=False,
    )
    engine = PRReviewEngine(backend, tmp_path / "gh", config)
    bot = AIBotComment(1, "greptile[bot]", "Greptile", "Hm.", None, None, "t")
    model.answer(text(fenced({"complexity": "low"})))

    asyncio.run(engine.run_multi_pass_review(pr(ai_bot_comments=[bot])))

    assert {c.options["project_dir"] for c in model.clients} == {backend}


def test_with_the_parallel_orchestrator_on_the_specialists_review_instead(
    tmp_path, model, gh, events
):
    config = GitHubRunnerConfig(
        token="placeholder",  # pragma: allowlist secret
        repo="own/repo",
    )
    engine = PRReviewEngine(tmp_path, tmp_path / "gh", config, events.append)
    (tmp_path / "app.py").write_text("a\nb\nc\nd\n", encoding="utf-8")
    model.answer(
        structured(
            {
                "specialist_name": "security",
                "analysis_summary": "Read the lookup.",
                "findings": [
                    {
                        "file": "app.py",
                        "line": 2,
                        "title": "Injectable query",
                        "description": "Built from input.",
                        "category": "security",
                        "severity": "critical",
                        "evidence": EVIDENCE,
                    }
                ],
            }
        )
    )
    sdk = StandInModel()
    sdk.answer()  # the finding validator says nothing: the findings stay
    reviewer_module = importlib.import_module(
        "runners.github.services.parallel_orchestrator_reviewer"
    )
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(reviewer_module, "create_agent_client", model.agent)
        patch.setattr(reviewer_module, "create_client", sdk.sdk)
        findings, issues, triages, summary = asyncio.run(
            engine.run_multi_pass_review(pr(head_sha=""))
        )

    assert [f.title for f in findings] == ["Injectable query"]
    assert issues == [] and triages == []
    assert summary == {
        "verdict": MergeVerdict.BLOCKED.value,
        "findings_count": 1,
        "strategy": "parallel_orchestrator",
    }
    assert events[0].phase == "orchestrating" and events[0].progress == 10


def test_duplicate_findings_keep_the_first_of_each_location_and_title(engine):
    def made(fid: str, title: str) -> PRReviewFinding:
        return PRReviewFinding(
            id=fid,
            severity=ReviewSeverity.LOW,
            category=ReviewCategory.STYLE,
            title=title,
            description="",
            file="a.py",
            line=1,
        )

    unique = engine.deduplicate_findings(
        [made("1", "Naming"), made("2", " naming "), made("3", "Other")]
    )

    assert [f.id for f in unique] == ["1", "3"]
