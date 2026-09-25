"""
Bounty Board — scoring.

The judge answers one question: *which contestant's change is the best answer
to this spec?* Everything here exists to keep that question from being
answered by something else.

The board this replaces scored four things — completion (50 points for not
crashing), acceptance-criteria coverage (the first word of a criterion found
as a substring anywhere in the prose), output length, and latency rank. Three
of them measure the *shape of the answer text* rather than the change, and the
fourth measures the field rather than the contestant. On a real run they
produced 77.9 / 77.8 / 67.9 for three models whose difference was the number
of characters in their own names.

Five rules replace them:

1. **Score the artifact, not the prose.** Every criterion below reads the diff
   the contestant produced or a command run against it. What the model *said*
   it did is not evidence.
2. **Absent evidence renormalises; it never scores zero.** A project with no
   test suite has not failed its tests. `Criterion.value is None` drops that
   criterion's weight out of the total, so the score stays on 0-100 and
   "unmeasured" never masquerades as "bad".
3. **No criterion is a rank.** The old latency term was
   `1 - duration/slowest`, so the slowest contestant scored exactly 0 whatever
   the gap — one millisecond cost a contestant ten points. Efficiency is now a
   ratio to the best, floored by the resolution below which a difference is
   measurement noise, so a photo finish scores as a photo finish.
4. **Efficiency is a tiebreaker, never a verdict.** It is dropped entirely
   unless a substantive criterion was measured: a score built only out of
   "returned first" is the previous board with better manners.
5. **The judge does not know who it is judging.** Diffs reach the model as
   "Candidate 1..N" with provider and model stripped. A judge told one diff is
   Claude's and another is a competitor's is measuring reputation.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .models import Contestant
from .signals import Evidence

logger = logging.getLogger(__name__)

# Weights out of 100, applied to whichever criteria have evidence. They are
# renormalised, so these are ratios between signals rather than absolute
# points: tests are worth a little over half again what the spec-fit judgement
# is worth, and efficiency can only ever break a near-tie.
WEIGHT_TESTS = 55.0
WEIGHT_SPEC_FIT = 35.0
WEIGHT_EFFICIENCY = 10.0

# Differences below these thresholds are measurement noise, not performance.
# Two agent sessions that finish 200 ms apart did not perform differently, and
# a board that says otherwise invites the reader to believe a ranking that is
# really jitter.
LATENCY_RESOLUTION_MS = 2000.0
COST_RESOLUTION_USD = 0.01


@dataclass
class Criterion:
    """One scored dimension.

    `value` is 0..1, or None when there was nothing to measure — which is a
    different statement from 0.0 and must stay different all the way to the UI.
    """

    name: str
    weight: float
    value: float | None
    detail: str

    @property
    def measured(self) -> bool:
        return self.value is not None


@dataclass
class Verdict:
    """The judge's answer for one contestant."""

    score: float
    criteria: list[Criterion] = field(default_factory=list)
    rationale: str = ""
    disqualified_reason: str | None = None

    def breakdown(self) -> dict[str, float | None]:
        return {
            c.name: (round(c.value * c.weight, 2) if c.measured else None)
            for c in self.criteria
        }


# ─── Criteria ──────────────────────────────────────────────────────────────────


def _tests_criterion(evidence: Evidence) -> Criterion:
    tests = evidence.tests
    if not tests.conclusive:
        reasons = {
            "no-command": "no test command declared by the project",
            "no-change": "no change to test",
            "timeout": "test suite timed out",
            "skipped": "test run disabled",
            "error": "test command could not be run",
        }
        return Criterion(
            "tests",
            WEIGHT_TESTS,
            None,
            reasons.get(tests.status, f"tests unavailable ({tests.status})"),
        )

    if tests.status == "passed":
        detail = (
            f"suite passed ({tests.passed} tests)" if tests.passed else "suite passed"
        )
        return Criterion("tests", WEIGHT_TESTS, 1.0, detail)

    # A failing suite is a real 0 on this criterion: the evidence exists and it
    # is bad. The counts refine nothing — a change that breaks one test out of
    # a thousand still breaks the build.
    detail = (
        f"suite failed ({tests.failed} failing)" if tests.failed else "suite failed"
    )
    return Criterion("tests", WEIGHT_TESTS, 0.0, detail)


def _spec_fit_criterion(rating: SpecFitRating | None) -> Criterion:
    if rating is None:
        return Criterion("spec_fit", WEIGHT_SPEC_FIT, None, "no judge available")
    return Criterion("spec_fit", WEIGHT_SPEC_FIT, rating.value, rating.detail)


def _efficiency_criterion(
    contestant: Contestant,
    best_duration_ms: float,
    best_cost_usd: float,
) -> Criterion:
    """How economical this contestant was, relative to the best of the field.

    A ratio to the *best*, not a rank against the worst. Twice as slow scores
    0.5; a hair slower scores a hair below 1.0. The resolution floors keep two
    effectively identical runs from being separated at all, which is precisely
    what the old `1 - duration/slowest` term got wrong.
    """
    parts: list[float] = []
    details: list[str] = []

    duration = max(float(contestant.duration_ms or 0), 0.0)
    if duration > 0 or best_duration_ms > 0:
        ratio = (best_duration_ms + LATENCY_RESOLUTION_MS) / (
            duration + LATENCY_RESOLUTION_MS
        )
        parts.append(min(1.0, max(0.0, ratio)))
        details.append(f"{duration / 1000:.1f}s")

    cost = max(float(contestant.cost_usd or 0.0), 0.0)
    if cost > 0 or best_cost_usd > 0:
        ratio = (best_cost_usd + COST_RESOLUTION_USD) / (cost + COST_RESOLUTION_USD)
        parts.append(min(1.0, max(0.0, ratio)))
        details.append(f"${cost:.4f}")

    if not parts:
        return Criterion(
            "efficiency", WEIGHT_EFFICIENCY, None, "no cost or duration recorded"
        )
    return Criterion(
        "efficiency", WEIGHT_EFFICIENCY, sum(parts) / len(parts), ", ".join(details)
    )


# ─── Spec fit (the one criterion that needs a model) ───────────────────────────


@dataclass
class SpecFitRating:
    value: float  # 0..1
    detail: str


SPEC_FIT_PROMPT = """You are judging an anonymous code contest.

Several candidates were given the SAME specification and each produced a diff.
Score how well each diff satisfies the specification.

Judge only what the diff does. You do not know which model wrote which diff,
and you must not guess: no candidate is favoured by style, verbosity or
convention. A short diff that satisfies the spec beats a long one that does not.

## Specification

{spec}

## Candidates

{candidates}

## Output

Return ONLY a JSON object, no prose and no code fence:

{{"ratings": [{{"candidate": 1, "score": 0.0, "reason": "one sentence"}}]}}

`score` is between 0.0 (does not address the specification) and 1.0 (fully
satisfies it). Give every candidate a rating.
"""


def _format_candidates(items: list[tuple[int, str]], max_chars_each: int) -> str:
    blocks = []
    for number, patch in items:
        body = patch.strip() or "(empty diff — this candidate changed nothing)"
        if len(body) > max_chars_each:
            body = body[:max_chars_each] + "\n… (diff truncated)"
        blocks.append(f"### Candidate {number}\n\n```diff\n{body}\n```")
    return "\n\n".join(blocks)


def _parse_ratings(text: str, expected: int) -> dict[int, SpecFitRating]:
    """Pull the ratings object out of the judge's answer.

    Tolerant of a fence or a sentence in front of the JSON, for the same reason
    `spec/plan_recovery.extract_json_document` is: the content is there, and
    refusing it over its wrapper spends a whole judging round to learn nothing.
    """
    candidates: list[str] = []
    if fenced := re.search(r"```(?:json)?\s*(.+?)```", text, re.DOTALL):
        candidates.append(fenced.group(1))
    if brace := re.search(r"\{.*\}", text, re.DOTALL):
        candidates.append(brace.group(0))
    candidates.append(text)

    for blob in candidates:
        try:
            data = json.loads(blob)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        ratings = data.get("ratings")
        if not isinstance(ratings, list):
            continue
        parsed: dict[int, SpecFitRating] = {}
        for entry in ratings:
            if not isinstance(entry, dict):
                continue
            try:
                number = int(entry.get("candidate"))
                score = float(entry.get("score"))
            except (TypeError, ValueError):
                continue
            if 1 <= number <= expected:
                parsed[number] = SpecFitRating(
                    value=min(1.0, max(0.0, score)),
                    detail=str(entry.get("reason") or "").strip()[:300]
                    or "rated by judge",
                )
        if parsed:
            return parsed
    return {}


async def rate_spec_fit(
    contestants: list[Contestant],
    evidences: dict[str, Evidence],
    spec_prompt: str,
    project_dir: Path,
    spec_dir: Path,
    *,
    max_chars_each: int = 24_000,
) -> dict[str, SpecFitRating]:
    """Ask one model to rate every diff against the spec, anonymously.

    Returns {contestant_id: rating}; an empty dict when no judge could run,
    which drops the criterion rather than scoring anyone down for it.

    The judge runs on the provider the project is configured with, not on any
    contestant's — a model asked to grade its own entry against a rival's is
    the one conflict of interest a scoring system cannot absorb — and it sees
    numbered candidates with no provider or model attached.
    """
    eligible = [
        c
        for c in contestants
        if c.status == "completed"
        and (evidences.get(c.id) or Evidence()).diff.patch.strip()
    ]
    if not eligible:
        return {}

    # The anonymisation is the shuffle-free part that matters: candidate order
    # follows board order, but nothing in the prompt says which entry is which
    # model, so the judge cannot prefer a brand.
    numbering = {index + 1: c for index, c in enumerate(eligible)}
    blocks = [
        (number, (evidences.get(c.id) or Evidence()).diff.patch)
        for number, c in numbering.items()
    ]
    prompt = SPEC_FIT_PROMPT.format(
        spec=spec_prompt.strip()[:20_000],
        candidates=_format_candidates(blocks, max_chars_each),
    )

    try:
        from agents.session import run_agent_session
        from core.client import create_agent_client
        from phase_config import get_phase_model
    except ImportError:
        logger.warning("Agent client unavailable — spec-fit judging skipped")
        return {}

    try:
        model = get_phase_model(spec_dir, "qa", cli_model=None)
        client = create_agent_client(
            project_dir=project_dir,
            spec_dir=spec_dir,
            model=model,
            agent_type="qa_reviewer",
            use_subagents=False,
        )
        async with client:
            _status, response, _err = await run_agent_session(client, prompt, spec_dir)
    except Exception:  # noqa: BLE001 - a judge that cannot run drops its criterion
        logger.warning("Spec-fit judging failed; criterion dropped", exc_info=True)
        return {}

    ratings = _parse_ratings(response or "", expected=len(numbering))
    if not ratings:
        logger.warning("Spec-fit judge returned no usable ratings; criterion dropped")
        return {}
    return {numbering[n].id: rating for n, rating in ratings.items() if n in numbering}


# ─── The judge ─────────────────────────────────────────────────────────────────


def score_contestant(
    contestant: Contestant,
    evidence: Evidence,
    spec_fit: SpecFitRating | None,
    best_duration_ms: float,
    best_cost_usd: float,
) -> Verdict:
    """Score one contestant on the evidence gathered for it."""
    # Two gates come before any criterion, because both describe a contestant
    # that produced nothing to score rather than one that scored badly.
    if contestant.status != "completed":
        return Verdict(
            score=0.0,
            rationale=contestant.error or "did not complete",
            disqualified_reason=contestant.error or "did not complete",
        )
    if evidence.diff.available and evidence.diff.is_empty:
        return Verdict(
            score=0.0,
            rationale="produced no change",
            disqualified_reason="produced no change",
        )

    tests = _tests_criterion(evidence)
    fit = _spec_fit_criterion(spec_fit)
    efficiency = _efficiency_criterion(contestant, best_duration_ms, best_cost_usd)
    criteria = [tests, fit, efficiency]

    # Efficiency is a tiebreaker and never a verdict. On its own it says only
    # that a contestant was quick, and "quick" was most of what the previous
    # board was really measuring — a run where nothing else could be checked
    # must report that, not crown whoever returned first.
    if not tests.measured and not fit.measured:
        return Verdict(
            score=0.0,
            criteria=criteria,
            rationale="nothing measurable: "
            + "; ".join(f"{c.name}: {c.detail}" for c in (tests, fit)),
            disqualified_reason="no signal could be measured",
        )

    measured = [c for c in criteria if c.measured]
    total_weight = sum(c.weight for c in measured)

    score = round(
        sum((c.value or 0.0) * c.weight for c in measured) * 100.0 / total_weight, 2
    )

    scored_part = ", ".join(
        f"{c.name} {c.value * 100:.0f}% (weight {c.weight / total_weight * 100:.0f}%) — {c.detail}"
        for c in measured
        if c.value is not None
    )
    skipped = [c for c in criteria if not c.measured]
    skipped_part = (
        " · not measured: " + ", ".join(f"{c.name} ({c.detail})" for c in skipped)
        if skipped
        else ""
    )
    return Verdict(
        score=score,
        criteria=criteria,
        rationale=f"{scored_part} → {score:.1f}{skipped_part}",
    )


async def evidence_judge(
    contestants: list[Contestant],
    evidences: dict[str, Evidence],
    spec_prompt: str,
    project_dir: Path,
    spec_dir: Path,
    *,
    use_model_judge: bool = True,
) -> tuple[str, dict[str, str]]:
    """Score every contestant and return (winner_id, rationale per contestant).

    The winner is the highest score above zero. A tie is reported as a tie
    rather than resolved by list order: the previous board's stable sort handed
    ties to whichever contestant was declared first, which at 0.1-point margins
    was most of them.
    """
    ratings: dict[str, SpecFitRating] = {}
    if use_model_judge:
        ratings = await rate_spec_fit(
            contestants, evidences, spec_prompt, project_dir, spec_dir
        )

    completed = [c for c in contestants if c.status == "completed"]
    durations = [float(c.duration_ms) for c in completed if c.duration_ms]
    costs = [float(c.cost_usd) for c in completed if c.cost_usd]
    best_duration = min(durations) if durations else 0.0
    best_cost = min(costs) if costs else 0.0

    rationale: dict[str, str] = {}
    scored: list[tuple[Contestant, float]] = []

    for contestant in contestants:
        evidence = evidences.get(contestant.id) or Evidence()
        verdict = score_contestant(
            contestant, evidence, ratings.get(contestant.id), best_duration, best_cost
        )
        contestant.score = verdict.score
        contestant.quality_breakdown = verdict.breakdown()
        contestant.evidence = evidence.to_dict()
        rationale[contestant.id] = verdict.rationale
        scored.append((contestant, verdict.score))

    scored.sort(key=lambda pair: pair[1], reverse=True)
    if not scored or scored[0][1] <= 0:
        return "", rationale

    top_score = scored[0][1]
    tied = [c for c, s in scored if s == top_score]
    if len(tied) > 1:
        names = ", ".join(c.label for c in tied)
        for contestant in tied:
            rationale[contestant.id] += f" · tied at {top_score:.1f} with {names}"
        # A tie is not a winner. Declaring one would be the same arbitrary
        # choice the old stable sort made, wearing a trophy.
        return "", rationale

    return scored[0][0].id, rationale


def summarize_criteria(contestants: list[Contestant]) -> dict[str, Any]:
    """What the board measured, for the report header."""
    return {
        "weights": {
            "tests": WEIGHT_TESTS,
            "spec_fit": WEIGHT_SPEC_FIT,
            "efficiency": WEIGHT_EFFICIENCY,
        },
        "note": "Weights are renormalised over the criteria that had evidence.",
        "contestants": len(contestants),
    }
