"""The render → diff → correct loop, bounded.

Version 0 is the code the pipeline generated. Each iteration asks the
correcting model for edits on the current version, renders the result and
compares it with the target again. The loop stops on the first of:

* ``converged``: the score reaches the threshold;
* ``max_iterations``: the number of corrections allowed (5 by default);
* ``budget``: before the next correction, the time allowed is spent, or the
  tokens or the cost allowed would be by a correction as large as the last one
  (``budget_kind`` says which: ``time``, ``tokens``, ``cost``; ``budget``);
* ``stalled``: the best score has not improved for ``patience`` corrections;
* ``failed``: a capture or the model call failed (the best version so far stays).

The version kept is the best-scoring one, not the last: a correction that
made things worse is not delivered. Each difference the diff found is tracked
across iterations as ``resolved``, ``open``, or ``abandoned`` when the loop
stopped without converging.
"""

from __future__ import annotations

import base64
import io
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from PIL import Image

from .budget import Pricing, Spend, Usage, estimate_usage
from .diff import (
    DEFAULT_TOLERANCE,
    Box,
    DiffReport,
    Region,
    compare,
    side_by_side,
    thumbnail,
)
from .feedback import apply_edits, build_feedback, build_prompt, parse_answer
from .render import RenderError

Render = Callable[[dict[str, str]], Awaitable[Image.Image]]
Progress = Callable[[dict], None]


class CorrectionError(RuntimeError):
    """The correcting model could not be asked or did not answer."""


@dataclass(frozen=True)
class Reply:
    """A correction's answer, and the tokens its provider reported (if any)."""

    text: str
    usage: Usage | None = None


#: A correction: the prompt and the composite picture to an answer.
Correct = Callable[[str, bytes], Awaitable[str | Reply]]


@dataclass
class LoopConfig:
    max_iterations: int = 5
    threshold: float = 0.95
    budget_seconds: float = 600.0
    tolerance: int = DEFAULT_TOLERANCE
    min_gain: float = 0.005
    patience: int = 2
    #: Tokens and US dollars the corrections may spend (0: no such budget).
    max_tokens: int = 400_000
    max_cost_usd: float = 2.0
    #: Passes the runner makes on the version kept, once the loop has stopped.
    responsive: bool = False
    states: bool = False
    #: One correction from the passes' findings, kept only when it helps.
    fix_passes: bool = False
    #: Zones the person drew on the design, as fractions ``(x, y, w, h)``:
    #: left out of the score, like the dynamic components.
    masks: tuple[tuple[float, float, float, float], ...] = ()


@dataclass
class Iteration:
    index: int
    score: float
    pixel_match: float
    ssim: float
    render_png: bytes
    diff_png: bytes
    regions: list[dict]
    applied_edits: int = 0
    refused_edits: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0
    tokens: int = 0
    cost_usd: float | None = None


@dataclass
class LoopOutcome:
    status: str
    iterations: list[Iteration]
    best_index: int
    files: dict[str, str]
    issues: list[dict]
    detail: str = ""
    budget_kind: str = ""
    spend: dict = field(default_factory=dict)
    #: The running total, for a correction made after the loop (the passes').
    ledger: Spend | None = None


def _data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _regions(report: DiffReport) -> list[dict]:
    return [
        {"name": r.name, "box": r.box.as_dict(), "score": r.score, "issues": r.issues}
        for r in report.regions
    ]


class _Tracker:
    """Each (region, kind, axis) difference, and what became of it."""

    def __init__(self) -> None:
        self.issues: dict[str, dict] = {}

    def update(self, report: DiffReport, index: int) -> None:
        present: set[str] = set()
        for region in report.regions:
            for issue in region.issues:
                key = f"{region.name}|{issue['kind']}|{issue.get('axis', '')}"
                present.add(key)
                entry = self.issues.setdefault(
                    key, {"id": key, "region": region.name, "first_seen": index}
                )
                entry.update(issue)
                entry.update(status="open", last_seen=index)
        for key, entry in self.issues.items():
            if key not in present and entry["status"] == "open":
                entry.update(status="resolved", resolved_at=index)

    def final(self, converged: bool) -> list[dict]:
        issues = list(self.issues.values())
        if not converged:
            for entry in issues:
                if entry["status"] == "open":
                    entry["status"] = "abandoned"
        return issues


async def run_loop(
    target: Image.Image,
    files: dict[str, str],
    *,
    render: Render,
    correct: Correct,
    regions: list[Region],
    masks: list[Box],
    stack_label: str,
    mirror: bool,
    config: LoopConfig | None = None,
    on_progress: Progress | None = None,
    clock: Callable[[], float] = time.monotonic,
    pricing: Pricing | None = None,
) -> LoopOutcome:
    """Run the loop from ``files``; ``render``, ``correct`` and ``pricing``
    (unknown when not given) are the runner's."""
    cfg = config or LoopConfig()
    started = clock()
    spend = Spend(pricing or Pricing())
    tracker = _Tracker()
    iterations: list[Iteration] = []
    best = 0
    versions: list[dict[str, str]] = [dict(files)]

    def notify(stage: str, index: int) -> None:
        if on_progress is not None:
            on_progress(
                {
                    "stage": stage,
                    "iteration": index,
                    "max_iterations": cfg.max_iterations,
                    "score": iterations[-1].score if iterations else None,
                    "best": iterations[best].score if iterations else None,
                }
            )

    def measure(rendered: Image.Image) -> DiffReport:
        return compare(
            target,
            rendered,
            regions,
            masks=masks,
            tolerance=cfg.tolerance,
            threshold=cfg.threshold,
        )

    def finish(status: str, detail: str = "", budget_kind: str = "") -> LoopOutcome:
        return LoopOutcome(
            status=status,
            iterations=iterations,
            best_index=best,
            files=versions[best],
            issues=tracker.final(status == "converged"),
            detail=detail,
            budget_kind=budget_kind,
            spend=spend.as_dict(cfg.max_tokens, cfg.max_cost_usd),
            ledger=spend,
        )

    notify("render", 0)
    try:
        rendered = await render(files)
    except RenderError as exc:
        return finish("failed", exc.code)
    report = measure(rendered)
    tracker.update(report, 0)
    iterations.append(
        Iteration(
            0,
            report.score,
            report.pixel_match,
            report.ssim,
            thumbnail(rendered),
            report.diff_png,
            _regions(report),
            duration_seconds=round(clock() - started, 2),
        )
    )
    current = dict(files)
    stale = 0

    for index in range(1, cfg.max_iterations + 1):
        if report.score >= cfg.threshold:
            return finish("converged")
        if clock() - started > cfg.budget_seconds:
            return finish("budget", budget_kind="time")
        spent = spend.exhausted(cfg.max_tokens, cfg.max_cost_usd)
        if spent:
            return finish("budget", budget_kind=spent)
        step_start = clock()
        notify("correct", index)
        feedback = build_feedback(report, iteration=index, threshold=cfg.threshold)
        prompt = build_prompt(feedback, current, stack_label=stack_label, mirror=mirror)
        diff_image = Image.open(io.BytesIO(report.diff_png)).convert("RGB")
        composite = side_by_side([target, rendered, diff_image])
        try:
            raw = await correct(prompt, composite)
        except CorrectionError as exc:
            return finish("failed", str(exc)[:300])
        reply = raw if isinstance(raw, Reply) else Reply(str(raw))
        with Image.open(io.BytesIO(composite)) as shown:
            size = shown.size
        tokens, cost = spend.add(
            reply.usage or estimate_usage(prompt, size, reply.text)
        )
        answer = parse_answer(reply.text)
        edits = answer.edits if answer else []
        candidate, applied, refused = apply_edits(current, edits)
        if applied:
            notify("render", index)
            try:
                rendered = await render(candidate)
            except RenderError as exc:
                return finish("failed", exc.code)
            report = measure(rendered)
            current = candidate
        tracker.update(report, index)
        versions.append(dict(current))
        iterations.append(
            Iteration(
                index,
                report.score,
                report.pixel_match,
                report.ssim,
                thumbnail(rendered),
                report.diff_png,
                _regions(report),
                applied_edits=applied,
                refused_edits=refused
                if answer
                else [{"path": "", "reason": "unreadable_answer"}],
                notes=answer.notes if answer else [],
                duration_seconds=round(clock() - step_start, 2),
                tokens=tokens,
                cost_usd=cost,
            )
        )
        previous_best = iterations[best].score
        if report.score > previous_best:
            best = index
        if report.score > previous_best + cfg.min_gain:
            stale = 0
        else:
            stale += 1
            if stale >= cfg.patience and report.score < cfg.threshold:
                return finish("stalled")
    return finish("converged" if report.score >= cfg.threshold else "max_iterations")


def serialize(
    outcome: LoopOutcome, *, threshold: float, mirror: bool, extra: dict
) -> dict:
    """The outcome as the page reads it (``DesignRenderLoop``)."""
    return {
        "status": outcome.status,
        "detail": outcome.detail,
        "budget_kind": outcome.budget_kind,
        "spend": outcome.spend,
        "threshold": threshold,
        "mirror": mirror,
        "best_iteration": outcome.best_index,
        "iterations": [
            {
                "index": it.index,
                "score": it.score,
                "pixel_match": it.pixel_match,
                "ssim": it.ssim,
                "render_image": _data_url(it.render_png),
                "diff_image": _data_url(it.diff_png),
                "regions": it.regions,
                "applied_edits": it.applied_edits,
                "refused_edits": it.refused_edits,
                "notes": it.notes,
                "duration_seconds": it.duration_seconds,
                "tokens": it.tokens,
                "cost_usd": it.cost_usd,
            }
            for it in outcome.iterations
        ],
        "issues": outcome.issues,
        **extra,
    }
