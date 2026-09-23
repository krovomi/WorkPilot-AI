import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from integrations.jev.context import select_state
from integrations.jev.models import JevContext, JevOutcome
from integrations.jev.reviews import evaluate_context
from integrations.jev.runtime import JevRun


def test_gitlab_patch_has_file_boundaries(tmp_path):
    worker = JevRun.from_env(
        JevContext("gitlab-review", tmp_path),
        env={"WORKPILOT_JEV_ENABLED": "1", "TYPESAFE_API_KEY": "fake"},
    )
    run = worker.fork()
    run.evaluate = AsyncMock(return_value=JevOutcome("evaluated"))
    worker.fork = lambda: run
    context = SimpleNamespace(
        title="Fix",
        description="Fix",
        head_sha="head",
        changed_files=[
            {
                "new_path": "app.py",
                "old_path": "app.py",
                "diff": "@@ -1 +1 @@\n-old\n+new",
            },
            {
                "new_path": ".env",
                "old_path": ".env",
                "diff": "@@ -1 +1 @@\n-old\n+PRIVATE=do-not-send",
            },
        ],
        diff="@@ unlabelled patches",
    )
    asyncio.run(evaluate_context(worker, context))
    assert run.evaluate.await_count == 1
    state = run.evaluate.call_args.kwargs["state"]
    assert "app.py" in state["diff"]
    assert "do-not-send" not in state["diff"]


def test_unified_review_diff_is_sanitized():
    state = select_state(
        request="fix",
        acceptance="fix",
        files=["app.py", ".env"],
        diff="--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-x\n+y\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-x\n+PRIVATE=do-not-send\n",
    )
    assert "do-not-send" not in state["diff"]
    assert "+y" in state["diff"]


def test_new_reviews_do_not_reuse_prior_decisions(tmp_path):
    worker = JevRun.from_env(JevContext("github-review", tmp_path), env={})
    context = SimpleNamespace(
        title="x", description="x", head_sha="one", changed_files=[], diff=""
    )
    first = asyncio.run(evaluate_context(worker, context))
    context.head_sha = "two"
    second = asyncio.run(evaluate_context(worker, context))
    assert first["runId"] != second["runId"]
    assert first["evaluations"][0]["revision"] == "one"
    assert second["evaluations"][0]["revision"] == "two"
