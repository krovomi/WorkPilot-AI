"""The prompts that author and repair an archify architecture model.

Built here rather than in `prompts_pkg`, which the QA loop and the workflow
runner import: these prompts have no reader outside archify, and building them
there put `architecture_visualizer` in the agents' import cycle (N8 A1, F131).
The text itself stays in `apps/backend/prompts/`, where every agent's system
prompt lives (`docs/architecture/agent-prompts.md`).
"""

from __future__ import annotations

import json
from pathlib import Path

# apps/backend/prompts
_PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"


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
        "\n".join(f"- `{path}`" for path in changed_files[:200])
        or "_The set of changed files could not be determined._"
    )
    section = _load("architecture_map_delta.md")
    section = section.replace("{{BASELINE_JSON}}", baseline_json)
    section = section.replace(
        "{{TASK_SUMMARY}}", task_summary.strip() or "_No summary available._"
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
