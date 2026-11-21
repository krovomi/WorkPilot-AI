"""What the correcting model is told, and what is done with its answer.

The report is neutral and structured: numbers measured by ``diff`` and one
plain sentence per difference ("background is #f08030 but should be
#e63946"), the same for every provider. The answer is a list of targeted
edits (exact text to find, text to put instead) rather than whole files: a
short answer a model can give within its output limit, which only touches what
it names. An edit that names a file the run does not have, or text that is not
in it exactly once, is refused and reported, never guessed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .diff import DiffReport, RegionDiff

PROMPT_FILE = (
    Path(__file__).resolve().parent.parent / "prompts" / "design_to_code_iteration.md"
)
MAX_EDITS = 40
MAX_REPLACE = 64 * 1024
#: How much of the files the prompt carries, all files together.
MAX_FILES_CHARS = 120_000

#: The static HTML mirror rendered in place of files a browser cannot open.
PREVIEW_PATH = "workpilot-preview.html"
_MIRROR_NOTE = (
    "The {stack} files cannot be rendered by a browser as they are, so the RENDER "
    "is {preview}: a static HTML mirror of those files. Make every visual fix "
    "in BOTH the {stack} files and {preview}, so the two stay the same screen."
)


def describe(issue: dict) -> str:
    """One neutral English sentence for a measured difference."""
    kind = issue["kind"]
    if kind == "color":
        return f"background is {issue['render']} but should be {issue['target']}"
    if kind == "offset":
        px = issue["px"]
        if issue["axis"] == "y":
            direction = "lower" if px > 0 else "higher"
        else:
            direction = "further right" if px > 0 else "further left"
        return f"content sits {abs(px)}px {direction} than in the target"
    if kind == "size":
        px = issue["px"]
        word = {"width": ("wider", "narrower"), "height": ("taller", "shorter")}[
            issue["axis"]
        ]
        return f"content is {abs(px)}px {word[0] if px > 0 else word[1]} than in the target"
    return "layout or shapes differ; no single colour, offset or size explains it"


def _region(diff: RegionDiff) -> dict:
    return {
        "name": diff.name,
        "box": diff.box.as_dict(),
        "score": diff.score,
        "pixel_match": diff.pixel_match,
        "ssim": diff.ssim,
        "differences": [{**issue, "message": describe(issue)} for issue in diff.issues],
    }


def build_feedback(report: DiffReport, *, iteration: int, threshold: float) -> dict:
    """The JSON the model reads: global score, then the failing regions, worst first."""
    failing = sorted((r for r in report.regions if r.issues), key=lambda r: r.score)
    return {
        "iteration": iteration,
        "score": report.score,
        "threshold": threshold,
        "pixel_match": report.pixel_match,
        "ssim": report.ssim,
        "size": {"width": report.width, "height": report.height},
        "ignored_share": report.masked_ratio,
        "regions": [_region(r) for r in failing],
    }


def files_block(files: dict[str, str]) -> str:
    """The files in delimited blocks, cut past ``MAX_FILES_CHARS`` in all."""
    parts: list[str] = []
    budget = MAX_FILES_CHARS
    for path, content in files.items():
        shown = content[:budget]
        budget -= len(shown)
        cut = (
            ""
            if len(shown) == len(content)
            else "\n[... cut: the rest of the file is unchanged ...]"
        )
        parts.append(f"<<<FILE {path}>>>\n{shown}{cut}\n<<<END FILE>>>")
    return "\n\n".join(parts)


def build_prompt(
    feedback: dict,
    files: dict[str, str],
    *,
    stack_label: str,
    mirror: bool,
) -> str:
    """The correction prompt, from ``prompts/design_to_code_iteration.md``."""
    template = PROMPT_FILE.read_text(encoding="utf-8")
    values = {
        "stack": stack_label,
        "width": str(feedback["size"]["width"]),
        "height": str(feedback["size"]["height"]),
        "threshold": str(feedback["threshold"]),
        "preview_note": mirror_note(stack_label) if mirror else "",
        "feedback": json.dumps(feedback, indent=2),
        "files": files_block(files),
    }
    return fill(template, values)


def mirror_note(stack_label: str) -> str:
    """What the model is told when the rendering is the static HTML mirror."""
    return _MIRROR_NOTE.format(stack=stack_label, preview=PREVIEW_PATH)


def fill(template: str, values: dict[str, str]) -> str:
    """``template`` with each ``{{key}}`` replaced by its value."""
    for key, value in values.items():
        template = template.replace("{{" + key + "}}", value)
    return template


@dataclass
class Edit:
    path: str
    find: str
    replace: str


@dataclass
class Answer:
    edits: list[Edit] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _json_object(raw: str) -> dict | None:
    text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", (raw or "").strip())
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def parse_answer(raw: str) -> Answer | None:
    """The edits of a model's answer, or None when it is not the JSON asked for."""
    data = _json_object(raw)
    if data is None or not isinstance(data.get("edits"), list):
        return None
    edits = [
        Edit(item["path"], item["find"], item["replace"])
        for item in data["edits"][:MAX_EDITS]
        if isinstance(item, dict)
        and all(isinstance(item.get(k), str) for k in ("path", "find", "replace"))
        and item["find"]
        and len(item["replace"]) <= MAX_REPLACE
    ]
    notes = [str(n)[:200] for n in data.get("notes") or [] if isinstance(n, str)][:10]
    return Answer(edits, notes)


def apply_edits(
    files: dict[str, str], edits: list[Edit]
) -> tuple[dict[str, str], int, list[dict]]:
    """(new files, edits applied, refused edits with their reason)."""
    result = dict(files)
    applied = 0
    refused: list[dict] = []
    for edit in edits:
        content = result.get(edit.path)
        if content is None:
            refused.append({"path": edit.path[:200], "reason": "unknown_file"})
            continue
        count = content.count(edit.find)
        if count != 1:
            refused.append(
                {
                    "path": edit.path,
                    "reason": "not_found" if count == 0 else "ambiguous",
                }
            )
            continue
        result[edit.path] = content.replace(edit.find, edit.replace, 1)
        applied += 1
    return result, applied, refused
