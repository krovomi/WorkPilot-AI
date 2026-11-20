"""The prompts that author and repair an archify architecture model.

Built here rather than in `prompts_pkg`, which the QA loop and the workflow
runner import: these prompts have no reader outside archify, and building them
there put `architecture_visualizer` in the agents' import cycle (N8 A1, F131).
The text itself stays in `apps/backend/prompts/`, where every agent's system
prompt lives (`docs/architecture/agent-prompts.md`).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from security.untrusted import quote_untrusted

# apps/backend/prompts
_PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"


def code_span(text: str) -> str:
    """A repository name inside a Markdown code span, on one line.

    A file or package name is the target repository's text: a backtick or a
    line break in it would end the span and put the rest of it in the prompt
    as prose.
    """
    return re.sub(r"[`\x00-\x1f\x7f]", "_", text)


def _load(filename: str) -> str:
    """A prompt file's text; `FileNotFoundError` when it is missing."""
    return (_PROMPTS_DIR / filename).read_text(encoding="utf-8")


def architecture_map_prompt(
    archify_root: Path,
    output_path: Path,
    evidence_section: str,
    baseline_section: str = "",
) -> str:
    """The prompt that authors an archify architecture model.

    `baseline_section` is empty for a project's first model and carries the
    delta contract — the base model plus the keep-every-id rule — when the model
    being written is the "after" side of a comparison. Two prompts would drift;
    one prompt with a section that is sometimes empty cannot.
    """
    prompt = _load("architecture_visualizer.md")
    prompt = prompt.replace("{{ARCHIFY_ROOT}}", str(archify_root))
    prompt = prompt.replace("{{OUTPUT_PATH}}", str(output_path))
    prompt = prompt.replace("{{EVIDENCE}}", evidence_section)
    prompt = prompt.replace("{{BASELINE}}", baseline_section)
    return prompt


def architecture_delta_section(
    baseline_json: str,
    task_summary: str,
    changed_files: list[str],
) -> str:
    """The "you are updating an existing model" half of the authoring prompt."""
    listing = (
        "\n".join(f"- `{code_span(path)}`" for path in changed_files[:200])
        or "_The set of changed files could not be determined._"
    )
    summary = task_summary.strip()
    section = _load("architecture_map_delta.md")
    section = section.replace("{{BASELINE_JSON}}", baseline_json)
    section = section.replace(
        "{{TASK_SUMMARY}}",
        quote_untrusted(summary, kind="issue_body", source="task description")
        if summary
        else "_No summary available._",
    )
    section = section.replace("{{CHANGED_FILES}}", listing)
    return section


def architecture_repair_prompt(
    output_path: Path,
    diagnostics: list[dict],
) -> str:
    """The follow-up pass after `archify validate` refused a candidate."""
    prompt = _load("architecture_map_repair.md")
    prompt = prompt.replace("{{OUTPUT_PATH}}", str(output_path))
    prompt = prompt.replace(
        "{{DIAGNOSTICS}}", json.dumps(diagnostics, indent=2, default=str)
    )
    return prompt
