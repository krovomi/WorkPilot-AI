"""Bounded evidence adapters shared by build and review orchestrators."""

from __future__ import annotations

import asyncio
import hashlib
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .context import JevContextError, select_state
from .models import JevOutcome, JevPoint
from .rubrics import classification_questions, review_questions
from .runtime import JevRun


@dataclass(frozen=True)
class ReviewInput:
    title: str
    body: str
    files: list[str]
    diff: str
    revision: str
    pass_id: str = "review"


def _read(path: Path) -> str:
    try:
        with path.open("rb") as stream:
            data = stream.read(65537)
        if len(data) > 65536:
            raise JevContextError("context_too_large")
        return data.decode("utf-8")
    except (OSError, UnicodeError):
        return ""


def _git(project: Path, *args: str) -> str:
    try:
        with tempfile.TemporaryFile() as output:
            subprocess.run(
                ["git", "-C", str(project), *args],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=True,
            )
            output.seek(0)
            data = output.read(65537)
        if len(data) > 65536:
            raise JevContextError("context_too_large")
        return data.decode("utf-8")
    except (OSError, UnicodeError, subprocess.SubprocessError):
        raise JevContextError("missing_context") from None


def _build_state(run: JevRun, point: JevPoint) -> tuple[dict, str]:
    directory = run.context.spec_dir
    if directory is None:
        raise JevContextError("missing_context")
    spec = _read(directory / "spec.md")
    if not spec.strip():
        raise JevContextError("missing_context")
    diff = ""
    files = []
    if point == "review":
        base = getattr(run, "base_revision", None)
        if not base:
            raise JevContextError("missing_context")
        diff = _git(
            run.context.project_dir,
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            base,
            "--",
        )
        files = _git(
            run.context.project_dir, "diff", "--name-only", base, "--"
        ).splitlines()
        if not diff.strip():
            raise JevContextError("missing_context")
    state = select_state(request=spec, acceptance=spec, files=files, diff=diff)
    revision = hashlib.sha256((spec + diff).encode("utf-8")).hexdigest()
    return state, revision


async def assess_build(run: JevRun, point: JevPoint, *, pass_id: str) -> JevOutcome:
    reason = run.eligibility()
    if reason:
        return run.record(
            point,
            pass_id=pass_id,
            revision="unavailable",
            outcome=JevOutcome("bypassed", reason),
        )
    try:
        state, revision = await asyncio.to_thread(_build_state, run, point)
    except JevContextError as exc:
        return run.record(
            point,
            pass_id=pass_id,
            revision="unavailable",
            outcome=JevOutcome("bypassed", exc.reason),
        )
    return await run.evaluate(
        point,
        pass_id=pass_id,
        revision=revision,
        state=state,
        questions=classification_questions()
        if point == "classification"
        else review_questions(),
    )


async def assess_review(run: JevRun, review: ReviewInput) -> JevOutcome:
    reason = run.eligibility()
    if reason:
        return run.record(
            "review",
            pass_id=review.pass_id,
            revision=review.revision,
            outcome=JevOutcome("bypassed", reason),
        )
    try:
        if not review.diff.strip():
            raise JevContextError("missing_context")
        state = select_state(
            request=review.title,
            acceptance=review.body,
            files=review.files,
            diff=review.diff,
        )
    except JevContextError as exc:
        return run.record(
            "review",
            pass_id=review.pass_id,
            revision=review.revision,
            outcome=JevOutcome("bypassed", exc.reason),
        )
    return await run.evaluate(
        "review",
        pass_id=review.pass_id,
        revision=review.revision,
        state=state,
        questions=review_questions()
        if review.body.strip()
        else {"risk": review_questions()["risk"]},
    )


def capture_base(run: JevRun, ref: str = "HEAD") -> None:
    if run.eligibility():
        return
    try:
        run.base_revision = _git(
            run.context.project_dir,
            "rev-parse",
            "--verify",
            "--end-of-options",
            ref + "^{commit}",
        ).strip()
    except JevContextError:
        run.base_revision = None


async def assess_planning(run: JevRun, request: str) -> JevOutcome:
    reason = run.eligibility()
    if reason:
        return run.record(
            "classification",
            pass_id="planning",
            revision="unavailable",
            outcome=JevOutcome("bypassed", reason),
        )
    try:
        spec = _read(run.context.spec_dir / "spec.md") if run.context.spec_dir else ""
        evidence = (spec + "\n\n" + request).strip()
        if not evidence.strip():
            raise JevContextError("missing_context")
        state = select_state(request=evidence, acceptance="", files=[])
    except JevContextError as exc:
        return run.record(
            "classification",
            pass_id="planning",
            revision="unavailable",
            outcome=JevOutcome("bypassed", exc.reason),
        )
    revision = hashlib.sha256(evidence.encode("utf-8")).hexdigest()
    return await run.evaluate(
        "classification",
        pass_id="planning",
        revision=revision,
        state=state,
        questions=classification_questions(),
    )
