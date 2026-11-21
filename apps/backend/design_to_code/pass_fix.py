"""One correction from the passes' findings, kept only when it helps (#379).

The responsive and states passes check the version the loop kept; on request,
what they found goes back to the correcting model once, as a list of neutral
sentences ("at 390px wide the page is 120px wider than the screen", "a "Buy"
shows no visible focus style"). The answer is checked and applied like any
correction (``feedback.apply_edits``), then the corrected version is measured
again: at the design's size against the design, and through the same passes.

It replaces the version kept only when the passes find fewer problems and the
score at the design's size has not dropped by more than ``min_gain``: a fix
for a narrow screen that breaks the design is not delivered. Its tokens count
in the loop's budget (``Spend``), and a budget already spent skips it.

Labels in the findings come from the generated markup (the passes trim them):
they reach the prompt inside a JSON block the prompt calls data.
"""

from __future__ import annotations

import base64
import io
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from .budget import Spend, estimate_usage
from .diff import load_image, side_by_side
from .feedback import apply_edits, files_block, fill, mirror_note, parse_answer
from .loop import CorrectionError, Reply
from .render import RenderError

PROMPT_FILE = (
    Path(__file__).resolve().parent.parent / "prompts" / "design_to_code_pass_fix.md"
)
#: Findings the prompt carries, and the page lists, at most.
MAX_FINDINGS = 24


@dataclass
class PassFix:
    """The report, and the files and passes to keep (None: keep the loop's)."""

    report: dict
    files: dict[str, str] | None = None
    passes: dict | None = None


def _responsive(report: dict) -> list[dict]:
    found: list[dict] = []
    for point in report.get("breakpoints") or []:
        if point.get("compared"):
            continue  # compared with the design: the loop's own work
        width = point.get("width")
        where = {"pass": "responsive", "breakpoint": point.get("name"), "width": width}
        if point.get("overflow_px"):
            found.append(
                {
                    **where,
                    "kind": "overflow",
                    "message": f"at {width}px wide the page is "
                    f"{point['overflow_px']}px wider than the screen",
                }
            )
        for label in point.get("overflowing") or []:
            found.append(
                {
                    **where,
                    "kind": "past_edge",
                    "message": f"{label} goes past the right edge at {width}px",
                }
            )
        for label in point.get("clipped") or []:
            found.append(
                {
                    **where,
                    "kind": "clipped",
                    "message": f"the text of {label} is cut by its box at {width}px",
                }
            )
        for first, second in point.get("overlaps") or []:
            found.append(
                {
                    **where,
                    "kind": "overlap",
                    "message": f"{first} lies over {second} at {width}px",
                }
            )
    return found


def _states(report: dict) -> list[dict]:
    found: list[dict] = []
    for element in report.get("elements") or []:
        label = element.get("label") or "an element"
        hover, focus = element.get("hover"), element.get("focus")
        if hover and not hover.get("changed"):
            found.append(
                {
                    "pass": "states",
                    "kind": "no_hover",
                    "message": f"{label} shows no hover style",
                }
            )
        # An element Tab never reached is not reported: the walk stops when
        # the page scrolls, so it may simply not have been reached yet.
        if focus and not focus.get("changed"):
            found.append(
                {
                    "pass": "states",
                    "kind": "no_focus",
                    "message": f"{label} shows no visible focus style (WCAG 2.4.7)",
                }
            )
    return found


def findings(passes: dict) -> list[dict]:
    """What the passes found that a correction can address, in order."""
    found: list[dict] = []
    responsive, states = passes.get("responsive"), passes.get("states")
    if isinstance(responsive, dict) and responsive.get("status") == "done":
        found += _responsive(responsive)
    if isinstance(states, dict) and states.get("status") == "done":
        found += _states(states)
    return found


def _image(data_url: object) -> Image.Image | None:
    if not isinstance(data_url, str) or "," not in data_url:
        return None
    return load_image(base64.b64decode(data_url.split(",", 1)[1]))


def composite(render_png: bytes, passes: dict, found: list[dict]) -> bytes:
    """The page at the design's size, then at each width where a problem was found."""
    images = [load_image(render_png)]
    widths = {f["breakpoint"] for f in found if f["pass"] == "responsive"}
    for point in (passes.get("responsive") or {}).get("breakpoints") or []:
        if point.get("name") in widths:
            image = _image(point.get("render_image"))
            if image is not None:
                images.append(image)
    return side_by_side(images)


def build_prompt(
    found: list[dict],
    files: dict[str, str],
    *,
    stack_label: str,
    mirror: bool,
    widths: list[str],
) -> str:
    """The prompt of ``prompts/design_to_code_pass_fix.md``."""
    return fill(
        PROMPT_FILE.read_text(encoding="utf-8"),
        {
            "stack": stack_label,
            "widths": ", ".join(widths) or "none",
            "preview_note": mirror_note(stack_label) if mirror else "",
            "findings": json.dumps(found[:MAX_FINDINGS], indent=2),
            "files": files_block(files),
        },
    )


async def fix_from_passes(
    files: dict[str, str],
    passes: dict,
    *,
    render_png: bytes,
    best_score: float,
    correct: Callable[[str, bytes], Awaitable[object]],
    score: Callable[[dict[str, str]], Awaitable[float]],
    rerun: Callable[[dict[str, str]], Awaitable[dict]],
    spend: Spend,
    max_tokens: int,
    max_cost_usd: float,
    min_gain: float,
    stack_label: str,
    mirror: bool,
) -> PassFix:
    """Ask once, measure again, and keep the result only if it helps.

    ``correct`` is the loop's (it raises ``CorrectionError``), ``score`` renders
    files at the design's size and scores them, ``rerun`` makes the same passes.
    """
    before = findings(passes)
    report: dict = {"before": len(before)}
    if not before:
        return PassFix({**report, "status": "nothing_to_fix"})
    spent = spend.exhausted(max_tokens, max_cost_usd)
    if spent:
        return PassFix({**report, "status": "budget", "budget_kind": spent})
    widths = list(
        dict.fromkeys(str(f["width"]) for f in before if f["pass"] == "responsive")
    )
    prompt = build_prompt(
        before, files, stack_label=stack_label, mirror=mirror, widths=widths
    )
    picture = composite(render_png, passes, before)
    try:
        raw = await correct(prompt, picture)
    except CorrectionError as exc:
        return PassFix({**report, "status": "failed", "detail": str(exc)[:300]})
    reply = raw if isinstance(raw, Reply) else Reply(str(raw))
    with Image.open(io.BytesIO(picture)) as shown:
        size = shown.size
    tokens, cost = spend.add(reply.usage or estimate_usage(prompt, size, reply.text))
    answer = parse_answer(reply.text)
    candidate, applied, refused = apply_edits(files, answer.edits if answer else [])
    report.update(
        applied_edits=applied,
        refused_edits=refused
        if answer
        else [{"path": "", "reason": "unreadable_answer"}],
        notes=answer.notes if answer else [],
        tokens=tokens,
        cost_usd=cost,
        score_before=best_score,
    )
    if not applied:
        return PassFix({**report, "status": "no_edits"})
    try:
        after_score = await score(candidate)
        after_passes = await rerun(candidate)
    except RenderError as exc:
        return PassFix({**report, "status": "failed", "detail": exc.code})
    after = findings(after_passes)
    remaining = {f["message"] for f in after}
    report.update(
        after=len(after),
        score=after_score,
        resolved=[f["message"] for f in before if f["message"] not in remaining][
            :MAX_FINDINGS
        ],
    )
    if after_score < best_score - min_gain:
        return PassFix({**report, "status": "regressed"})
    if len(after) >= len(before):
        return PassFix({**report, "status": "no_gain"})
    return PassFix({**report, "status": "kept"}, candidate, after_passes)
