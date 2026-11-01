"""
Prompt Loading Utilities
========================

Functions for loading agent prompts from markdown files.
Supports dynamic prompt assembly based on project type for context optimization.
"""

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING

from foundation.base_branch import detect_base_branch

if TYPE_CHECKING:
    from foundation.change_scope import ChangeScope

from .project_context import (
    detect_project_capabilities,
    get_mcp_tools_for_project,
    load_project_index,
)

# Directory containing prompt files
# prompts/ is a sibling directory of prompts_pkg/, so go up one level first
PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


def get_planner_prompt(spec_dir: Path) -> str:
    """
    Load the planner agent prompt with spec path injected.
    The planner creates subtask-based implementation plans.

    Args:
        spec_dir: Directory containing the spec.md file

    Returns:
        The planner prompt content with spec path
    """
    prompt_file = PROMPTS_DIR / "planner.md"

    if not prompt_file.exists():
        raise FileNotFoundError(
            f"Planner prompt not found at {prompt_file}\n"
            "Make sure the auto-claude/prompts/planner.md file exists."
        )

    prompt = prompt_file.read_text(encoding="utf-8")

    # Keep the planner prompt in sync with the Coverage Enforcement Gate threshold.
    prompt = prompt.replace("{{MIN_COVERAGE}}", str(_min_coverage()))

    # Inject spec directory information at the beginning
    spec_context = f"""## SPEC LOCATION

Your spec file is located at: `{spec_dir}/spec.md`

🚨 CRITICAL FILE CREATION INSTRUCTIONS 🚨

You MUST use the Write tool to create these files in the spec directory:
- `{spec_dir}/implementation_plan.json` - Subtask-based implementation plan (USE WRITE TOOL!)
- `{spec_dir}/init.sh` - Environment setup script, only if missing (USE WRITE TOOL!)

DO NOT just describe what these files should contain. You MUST actually call the Write tool
with the file path and complete content to create them.

The project root is the parent of auto-claude/. Implement code in the project root, not in the spec directory.

---

"""
    return spec_context + prompt


def get_followup_planner_prompt(spec_dir: Path) -> str:
    """
    Load the follow-up planner agent prompt with spec path and key files injected.
    The follow-up planner adds new subtasks to an existing completed implementation plan.

    Args:
        spec_dir: Directory containing the completed spec and implementation_plan.json

    Returns:
        The follow-up planner prompt content with paths injected
    """
    prompt_file = PROMPTS_DIR / "followup_planner.md"

    if not prompt_file.exists():
        raise FileNotFoundError(
            f"Follow-up planner prompt not found at {prompt_file}\n"
            "Make sure the auto-claude/prompts/followup_planner.md file exists."
        )

    prompt = prompt_file.read_text(encoding="utf-8")

    # Inject spec directory information at the beginning
    spec_context = f"""## SPEC LOCATION (FOLLOW-UP MODE)

You are adding follow-up work to a **completed** spec.

**Key files in this spec directory:**
- Spec: `{spec_dir}/spec.md`
- Follow-up request: `{spec_dir}/FOLLOWUP_REQUEST.md` (READ THIS FIRST!)
- Implementation plan: `{spec_dir}/implementation_plan.json` (APPEND to this, don't replace)
- Progress notes: `{spec_dir}/build-progress.txt`
- Context: `{spec_dir}/context.json`
- Memory: `{spec_dir}/memory/`

**Important paths:**
- Spec directory: `{spec_dir}`
- Project root: Parent of auto-claude/ (where code should be implemented)

**Your task:**
1. Read `{spec_dir}/FOLLOWUP_REQUEST.md` to understand what to add
2. Read `{spec_dir}/implementation_plan.json` to see existing phases/subtasks
3. ADD new phase(s) with pending subtasks to the existing plan
4. PRESERVE all existing subtasks and their statuses

---

"""
    return spec_context + prompt


def is_first_run(spec_dir: Path) -> bool:
    """
    Check if this is the first run (no valid implementation plan with subtasks exists yet).

    The spec runner may create a skeleton implementation_plan.json with empty phases.
    This function checks for actual phases with subtasks, not just file existence.

    Args:
        spec_dir: Directory containing spec files

    Returns:
        True if implementation_plan.json doesn't exist or has no subtasks
    """
    plan_file = spec_dir / "implementation_plan.json"

    if not plan_file.exists():
        return True

    try:
        with open(plan_file, encoding="utf-8") as f:
            plan = json.load(f)

        # Check if there are any phases with subtasks
        phases = plan.get("phases", [])
        if not phases:
            return True

        # Check if any phase has subtasks
        total_subtasks = sum(len(phase.get("subtasks", [])) for phase in phases)
        return total_subtasks == 0
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        # If we can't read the file, treat as first run
        return True


def _min_coverage() -> int:
    """Seuil de couverture minimal requis (WORKPILOT_QA_MIN_COVERAGE, défaut 100)."""
    try:
        from qa.coverage_gate import get_min_coverage

        return get_min_coverage()
    except Exception:
        return 100


def _load_prompt_file(filename: str) -> str:
    """
    Load a prompt file from the prompts directory.

    Args:
        filename: Relative path to prompt file (e.g., "qa_reviewer.md" or "mcp_tools/electron_validation.md")

    Returns:
        Content of the prompt file

    Raises:
        FileNotFoundError: If prompt file doesn't exist
    """
    prompt_file = PROMPTS_DIR / filename
    if not prompt_file.exists():
        raise FileNotFoundError(f"Prompt file not found: {prompt_file}")
    return prompt_file.read_text(encoding="utf-8")


def constitution_section(project_dir: Path) -> str:
    """The house rules of a spec-kit project, when the target project is one.

    One `is_file()` for every other project, and "" for it. See
    `project.spec_kit` for why only the constitution is read and not the rest
    of spec-kit's artifacts.

    Public and single: the planner, every coding subtask, the QA reviewer and
    the workflow's skill phases all need the same section, and four copies of
    a three-line wrapper is four places to forget the guard.
    """
    try:
        from project.spec_kit import format_constitution_for_prompt

        return format_constitution_for_prompt(project_dir)
    except Exception:  # noqa: BLE001 - a missing section never stops a phase
        return ""


def mobile_section(project_dir: Path) -> str:
    """What a phone application adds to a phase's prompt, when it is one.

    Public and single for the same reason `constitution_section` is: the
    planner, every coding subtask and the QA reviewer need the identical
    section, and a phase that gets it wrong plans against commands that do not
    build. One `detect_stack` for every other project, and "" for it.
    """
    try:
        from mobile import mobile_section as _section

        return _section(project_dir)
    except Exception:  # noqa: BLE001 - a missing section never stops a phase
        return ""


def docintel_section(project_dir: Path, spec_dir: Path | None = None) -> str:
    """The project's accepted ADRs, and what the task's attachments say.

    Public and single for the same reason as the two above: the planner, every
    coding subtask, the QA reviewer and the workflow's skill phases need the
    identical section. Empty for a project with no ADRs and a task with no
    attachments, which is most of them.
    """
    try:
        from docintel import docintel_section as _section

        return _section(project_dir, spec_dir)
    except Exception:  # noqa: BLE001 - a missing section never stops a phase
        return ""


def uiux_section(
    spec_dir: Path | None, subtask: dict | None = None, *, role: str = "coder"
) -> str:
    """The design system of a UI task (ui-ux-pro-max), or nothing.

    Public and single like the three above: the coder (per subtask), the QA
    reviewer and the workflow's skill phases read the identical section. Empty
    on a task — or a subtask — that does not touch the interface, which is what
    keeps a backend task from paying for it.
    """
    try:
        from uiux import uiux_section as _section

        return _section(spec_dir, subtask, role=role)
    except Exception:  # noqa: BLE001 - a missing section never stops a phase
        return ""


def verify_section(spec_dir: Path | None) -> str:
    """The runtime verification's record (`verify.prompt`), for QA.

    Empty when no verification ran. Never raises: a missing section never stops
    a phase.
    """
    try:
        from verify.prompt import verify_section as _section

        return _section(spec_dir)
    except Exception:  # noqa: BLE001
        return ""


def workflow_reports_section(
    spec_dir: Path | None, consumer: str, *, inline: bool = True
) -> str:
    """What the skill phases before `consumer` reported (`workflows.handoff`).

    `consumer` is `planning`, `coding` or `qa`. Public and single like the
    sections above: the planner, every coder subtask and the QA reviewer read
    it, and each skill phase's report is otherwise read by nobody. Empty when
    no such phase ran. Never raises.
    """
    try:
        from workflows.handoff import handoff_section

        return handoff_section(spec_dir, consumer, inline=inline)
    except Exception:  # noqa: BLE001 - a missing section never stops a phase
        return ""


def get_qa_reviewer_prompt(spec_dir: Path, project_dir: Path) -> str:
    """
    Load the QA reviewer prompt with project-specific MCP tools dynamically injected.

    This function:
    1. Loads the base QA reviewer prompt
    2. Detects project capabilities from project_index.json
    3. Injects only relevant MCP tool documentation (Electron, Puppeteer, DB, API)
    4. Detects and injects the correct base branch for git comparisons

    This saves context window by excluding irrelevant tool docs.
    For example, a CLI Python project won't get Electron validation docs.

    Args:
        spec_dir: Directory containing the spec files
        project_dir: Root directory of the project

    Returns:
        The QA reviewer prompt with project-specific tools injected
    """
    # Detect the base branch for this task (from task_metadata.json or auto-detect)
    base_branch = detect_base_branch(spec_dir, project_dir)

    # Load base QA reviewer prompt
    base_prompt = _load_prompt_file("qa_reviewer.md")

    # Replace {{BASE_BRANCH}} placeholder with the actual base branch
    base_prompt = base_prompt.replace("{{BASE_BRANCH}}", base_branch)

    # Replace {{SPEC_DIR}} placeholder with the absolute spec directory path
    # This ensures the QA agent uses correct paths for implementation_plan.json etc.
    base_prompt = base_prompt.replace("{{SPEC_DIR}}", str(spec_dir))

    # Replace {{MIN_COVERAGE}} with the enforced minimum test coverage threshold.
    # Controlled by WORKPILOT_QA_MIN_COVERAGE (default 100). This keeps the prompt
    # in sync with the deterministic Coverage Enforcement Gate in qa/loop.py.
    base_prompt = base_prompt.replace("{{MIN_COVERAGE}}", str(_min_coverage()))
    project_index = load_project_index(project_dir)
    capabilities = detect_project_capabilities(project_index)

    # Get list of MCP tool doc files to include
    mcp_tool_files = get_mcp_tools_for_project(capabilities)

    # Load and assemble MCP tool sections
    mcp_sections = []
    for tool_file in mcp_tool_files:
        try:
            section = _load_prompt_file(tool_file)
            mcp_sections.append(section)
        except FileNotFoundError:
            # Skip missing files gracefully
            pass

    # Inject spec context at the beginning
    spec_context = f"""## SPEC LOCATION

Your spec and progress files are located at:
- Spec: `{spec_dir}/spec.md`
- Implementation plan: `{spec_dir}/implementation_plan.json`
- Progress notes: `{spec_dir}/build-progress.txt`
- QA report output: `{spec_dir}/qa_report.md`
- Fix request output: `{spec_dir}/QA_FIX_REQUEST.md`

The project root is: `{project_dir}`

## GIT BRANCH CONFIGURATION

**Base branch for comparison:** `{base_branch}`

When checking for unrelated changes, use three-dot diff syntax:
```bash
git diff {base_branch}...HEAD --name-status
```

This shows only changes made in the spec branch since it diverged from `{base_branch}`.

---

## PROJECT CAPABILITIES DETECTED

"""

    # Add capability summary for transparency
    active_caps = [k for k, v in capabilities.items() if v]
    if active_caps:
        spec_context += (
            "Based on project analysis, the following capabilities were detected:\n"
        )
        for cap in active_caps:
            cap_name = (
                cap.replace("is_", "").replace("has_", "").replace("_", " ").title()
            )
            spec_context += f"- {cap_name}\n"
        spec_context += "\nRelevant validation tools have been included below.\n\n"
    else:
        spec_context += (
            "No special project capabilities detected. Using standard validation.\n\n"
        )

    spec_context += "---\n\n"

    # A spec-kit project's own binding rules. The planner and the coder already
    # get them; QA is the phase that decides whether the result is acceptable,
    # and a reviewer judging against conventions it inferred from the codebase
    # while the project has written its rules down is judging the wrong thing.
    # Empty for every project without `.specify/`.
    if constitution := constitution_section(project_dir):
        spec_context += constitution + "\n\n---\n\n"

    # A phone application is not validated the way a web app is: there is no
    # URL to open, the evidence is a screenshot from a device, and one of the
    # two platforms may not be buildable on this machine at all. A reviewer
    # that does not know which is which reports "could not verify" as a defect.
    if mobile := mobile_section(project_dir):
        spec_context += mobile + "\n\n---\n\n"

    # The decisions the project wrote down, and the mockup or diagram the
    # person attached to the task: the two things a reviewer judging only the
    # diff against the spec text cannot see.
    if documents := docintel_section(project_dir, spec_dir):
        spec_context += documents + "\n\n---\n\n"

    # The design system the coder was told to build against, and upstream's
    # pre-delivery checklist, so the UI files of the diff are judged against
    # the same palette and rules. Empty when the task is not about the UI.
    if design := uiux_section(spec_dir, role="qa"):
        spec_context += design + "\n\n---\n\n"

    # What the review phase found, from a reader that did not write the code.
    # Claims to verify, not verdicts: this reviewer still decides. Without it,
    # the review session was paid for and its report read by nobody.
    if reports := workflow_reports_section(spec_dir, "qa"):
        spec_context += reports + "\n\n---\n\n"

    # The app this task changed, launched and driven before review: what it
    # printed, the state it reached, the endpoints it answered. Evidence the
    # reviewer can cite instead of redoing — and a failure it must report.
    if verification := verify_section(spec_dir):
        spec_context += verification + "\n\n---\n\n"

    # Find injection point in base prompt (after PHASE 4, before PHASE 5)
    injection_marker = (
        "<!-- PROJECT-SPECIFIC VALIDATION TOOLS WILL BE INJECTED HERE -->"
    )

    if mcp_sections and injection_marker in base_prompt:
        # Replace marker with actual MCP tool sections
        mcp_content = "\n\n---\n\n## PROJECT-SPECIFIC VALIDATION TOOLS\n\n"
        mcp_content += "The following validation tools are available based on your project type:\n\n"
        mcp_content += "\n\n---\n\n".join(mcp_sections)
        mcp_content += "\n\n---\n"

        # Replace the multi-line marker comment block
        marker_pattern = r"<!-- PROJECT-SPECIFIC VALIDATION TOOLS WILL BE INJECTED HERE -->.*?<!-- - API validation \(for projects with API endpoints\) -->"
        base_prompt = re.sub(marker_pattern, mcp_content, base_prompt, flags=re.DOTALL)
    elif mcp_sections:
        # Fallback: append at the end if marker not found
        base_prompt += "\n\n---\n\n## PROJECT-SPECIFIC VALIDATION TOOLS\n\n"
        base_prompt += "\n\n---\n\n".join(mcp_sections)

    return spec_context + base_prompt


#: What the light review inlines, so the reviewer reads the evidence from its
#: prompt instead of spending turns (and context) fetching it.
LIGHT_QA_SPEC_MAX_CHARS = 8_000
LIGHT_QA_DIFF_MAX_CHARS = 12_000


#: The light review's instructions when git shows no change at all: the spec
#: may already hold on the base branch. Only that pass pays for them.
LIGHT_QA_EMPTY_CHANGE = """
### If the change is empty

No file differs from the base branch: the coder changed nothing. The spec may
already hold there (for example the file it asks for was merged by an earlier
task, with the right content). Open the files the spec names, as they are now:

- every criterion holds → `approved` (the repository already met the spec);
- otherwise → `rejected`, one issue per criterion not met, naming the file
  and the content the spec asks for.

Never ask for tests, a test project, coverage or documentation the spec does
not name: nothing a program reads changed, so there is nothing to test.
"""


def get_qa_reviewer_light_prompt(
    spec_dir: Path, project_dir: Path, scope: "ChangeScope"
) -> str:
    """The QA reviewer prompt for a change set of text files only.

    `foundation.change_scope` decided from git that nothing a program reads
    changed. The full prompt would still send the reviewer to start the dev
    environment, run every suite with coverage and grep the whole repository;
    this one inlines the spec and the diff and asks the one question left:
    is this the change the spec asked for. Same sign-off contract, same
    verdict line, so the loop reads it like any other pass.
    """
    from foundation.change_scope import change_diff

    try:
        spec = (spec_dir / "spec.md").read_text(encoding="utf-8")
    except OSError:
        spec = f"(spec.md not readable — read `{spec_dir}/spec.md`)"
    if len(spec) > LIGHT_QA_SPEC_MAX_CHARS:
        spec = (
            spec[:LIGHT_QA_SPEC_MAX_CHARS]
            + f"\n\n[... truncated: read `{spec_dir}/spec.md` for the rest ...]"
        )
    empty_change = ""
    if scope.files:
        diff = change_diff(project_dir, scope, LIGHT_QA_DIFF_MAX_CHARS) or (
            "(diff unavailable — read the changed files)"
        )
        files = ", ".join(f"`{f}`" for f in scope.files)
    else:
        diff = "(empty: no file differs from the base branch)"
        files = "none — see « If the change is empty » below"
        empty_change = LIGHT_QA_EMPTY_CHANGE
    base_branch = detect_base_branch(spec_dir, project_dir)
    prompt = _load_prompt_file("qa_reviewer_light.md")
    for key, value in (
        ("{{BASE_BRANCH}}", base_branch),
        ("{{SPEC_DIR}}", str(spec_dir)),
        ("{{FILES}}", files),
        ("{{EMPTY_CHANGE}}", empty_change),
    ):
        prompt = prompt.replace(key, value)
    # Spec and diff last: they are data, and must not be scanned for
    # placeholders themselves.
    prompt = prompt.replace("{{SPEC}}", spec.replace("{{", "{ {"), 1)
    prompt = prompt.replace("{{DIFF}}", diff.replace("```", "``​`"), 1)
    header = (
        "## SPEC LOCATION\n\n"
        f"- Spec: `{spec_dir}/spec.md`\n"
        f"- Implementation plan: `{spec_dir}/implementation_plan.json`\n\n"
        f"The project root is: `{project_dir}`\n\n---\n\n"
    )
    return header + prompt


def get_qa_fixer_prompt(spec_dir: Path, project_dir: Path) -> str:
    """
    Load the QA fixer prompt with spec paths injected.

    Args:
        spec_dir: Directory containing the spec files
        project_dir: Root directory of the project

    Returns:
        The QA fixer prompt content with paths injected
    """
    base_prompt = _load_prompt_file("qa_fixer.md")

    # Replace {{SPEC_DIR}} placeholder with the absolute spec directory path
    base_prompt = base_prompt.replace("{{SPEC_DIR}}", str(spec_dir))

    # Keep the fixer prompt in sync with the Coverage Enforcement Gate threshold.
    base_prompt = base_prompt.replace("{{MIN_COVERAGE}}", str(_min_coverage()))

    spec_context = f"""## SPEC LOCATION

Your spec and progress files are located at:
- Spec: `{spec_dir}/spec.md`
- Implementation plan: `{spec_dir}/implementation_plan.json`
- QA fix request: `{spec_dir}/QA_FIX_REQUEST.md` (READ THIS FIRST!)
- QA report: `{spec_dir}/qa_report.md`

The project root is: `{project_dir}`

---

"""
    if verification := verify_section(spec_dir):
        spec_context += verification + "\n\n---\n\n"
    return spec_context + base_prompt
