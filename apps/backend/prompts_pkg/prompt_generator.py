"""
Prompt Generator
================

Generates minimal, focused prompts for each subtask.
Instead of a 900-line mega-prompt, each subtask gets a tailored ~100-line prompt
with only the context it needs.

This approach:
- Reduces token usage by ~80%
- Keeps the agent focused on ONE task
- Moves bookkeeping to Python orchestration
"""

import json
import os
import re
from pathlib import Path

from foundation.change_scope import is_text_only_path
from foundation.dotnet_tools import generate_dotnet_env_section
from foundation.human_input import human_input_section, read_human_input

# Stack-aware automatic test planning (API contract / WinForms UI / web E2E
# tests derived from the touched files + installed libraries). Optional: the
# prompt builder must keep working if the module is unavailable.
try:
    from project.test_stack import build_auto_test_instructions
except ImportError:  # pragma: no cover - packaging edge case
    build_auto_test_instructions = None

# Worktree path patterns for detection
# Matches paths like: .workpilot/worktrees/tasks/{spec-name}/
WORKTREE_PATH_PATTERNS = [
    r"[/\\]\.workpilot[/\\]worktrees[/\\]tasks[/\\]",
    r"[/\\]\.workpilot[/\\]github[/\\]pr[/\\]worktrees[/\\]",  # PR review worktrees
    r"[/\\]\.worktrees[/\\]",  # Legacy worktree location
]

# Verification types that can be proven by running an automated test/command.
# Only these get the strict TDD (Red-Green-Refactor) cycle injected.
TDD_TESTABLE_VERIFICATION_TYPES = {"command", "api", "e2e"}

# Phase types where TDD does not apply (no production code to test-drive).
TDD_SKIPPED_PHASE_TYPES = {"investigation", "setup", "cleanup"}


def is_tdd_enabled() -> bool:
    """Return True when strict TDD mode is enabled via the TDD_MODE env var.

    Set by the frontend (per-project "Mode TDD" toggle) when spawning the agent
    process, mirroring the USE_CLAUDE_MD flag pattern.
    """
    return os.environ.get("TDD_MODE", "").lower() == "true"


def subtask_is_tdd_eligible(subtask: dict, phase: dict) -> bool:
    """Decide whether a subtask should follow the strict TDD cycle.

    Eligible when its verification can be proven by an automated test/command
    and the phase actually produces production code. Manual/none/browser
    verifications and investigation/setup/cleanup phases keep the classic flow,
    and so does a subtask whose files are all plain text or documentation
    (`foundation.change_scope.is_text_only_path`): there is no behaviour to
    drive with a test, and a test asserting a `.txt` holds "OK" restates the
    file at the price of a full red-green-refactor session.
    """
    files = [
        *(subtask.get("files_to_create") or []),
        *(subtask.get("files_to_modify") or []),
    ]
    if files and all(isinstance(f, str) and is_text_only_path(f) for f in files):
        return False
    verification = subtask.get("verification") or {}
    v_type = (verification.get("type") or "manual").lower()
    phase_type = (phase.get("type") or "").lower()

    if v_type not in TDD_TESTABLE_VERIFICATION_TYPES:
        return False
    if phase_type in TDD_SKIPPED_PHASE_TYPES:
        return False
    return True


def detect_worktree_isolation(project_dir: Path) -> tuple[bool, Path | None]:
    """
    Detect if the project_dir is inside an isolated worktree.

    When running in a worktree, the agent should NOT escape to the parent project.
    This function detects worktree mode and extracts the forbidden parent path.

    Args:
        project_dir: The working directory for the AI

    Returns:
        Tuple of (is_worktree, parent_project_path)
        - is_worktree: True if running in an isolated worktree
        - parent_project_path: The forbidden parent project path (None if not in worktree)
    """
    # Resolve the path first for consistent matching across platforms
    # This handles Windows drive letters, symlinks, and relative paths
    resolved_dir = project_dir.resolve()
    project_str = str(resolved_dir)

    for pattern in WORKTREE_PATH_PATTERNS:
        match = re.search(pattern, project_str)
        if match:
            # Extract the parent project path (everything before the worktree marker)
            parent_path = project_str[: match.start()]
            # Handle edge case where worktree is at filesystem root
            if not parent_path:
                parent_path = resolved_dir.anchor
            return True, Path(parent_path)

    return False, None


def generate_worktree_isolation_warning(
    project_dir: Path, parent_project_path: Path
) -> str:
    """
    Generate the worktree isolation warning section for prompts.

    This warning explicitly tells the agent that it's in an isolated worktree
    and must NOT escape to the parent project directory.

    Args:
        project_dir: The worktree directory (agent's working directory)
        parent_project_path: The forbidden parent project path

    Returns:
        Markdown string with isolation warning
    """
    return f"""## ⛔ ISOLATED WORKTREE - CRITICAL

You are in an **ISOLATED GIT WORKTREE** - a complete copy of the project for safe development.

**YOUR LOCATION:** `{project_dir}`
**FORBIDDEN PATH:** `{parent_project_path}`

### Rules:
1. **NEVER** use `cd {parent_project_path}` or any path starting with `{parent_project_path}`
2. **NEVER** use absolute paths that reference the parent project
3. **ALL** project files exist HERE via relative paths

### Why This Matters:
- Git commits made in the parent project go to the WRONG branch
- File changes in the parent project escape isolation
- This defeats the entire purpose of safe, isolated development

### Correct Usage:
```bash
# ✅ CORRECT - Use relative paths from your worktree
./prod/src/file.ts
./apps/frontend/src/component.tsx

# ❌ WRONG - These escape isolation!
cd {parent_project_path}
{parent_project_path}/prod/src/file.ts
```

If you see absolute paths in spec.md or context.json that reference `{parent_project_path}`,
convert them to relative paths from YOUR current location.

---

"""


def get_relative_spec_path(spec_dir: Path, project_dir: Path) -> str:
    """
    Get the spec directory path relative to the project/working directory.

    This ensures the AI gets a usable path regardless of absolute locations.

    Args:
        spec_dir: Absolute path to spec directory
        project_dir: Absolute path to project/working directory

    Returns:
        Relative path string (e.g., "./auto-claude/specs/003-new-spec")
    """
    try:
        # Try to make path relative to project_dir
        relative = spec_dir.relative_to(project_dir)
        return f"./{relative}"
    except ValueError:
        # If spec_dir is not under project_dir, return the name only
        # This shouldn't happen if workspace.py correctly copies spec files
        return f"./auto-claude/specs/{spec_dir.name}"


def generate_environment_context(project_dir: Path, spec_dir: Path) -> str:
    """
    Generate environment context header for prompts.

    This explicitly tells the AI where it is working, preventing path confusion.
    When running in a worktree, includes an isolation warning to prevent escaping.
    For .NET projects on Windows, injects build tool paths and shell restrictions.

    Args:
        project_dir: The working directory for the AI
        spec_dir: The spec directory (may be absolute or relative)

    Returns:
        Markdown string with environment context
    """
    relative_spec = get_relative_spec_path(spec_dir, project_dir)

    # Check if we're in an isolated worktree
    is_worktree, parent_project_path = detect_worktree_isolation(project_dir)

    # Start with worktree isolation warning if applicable
    sections = []
    if is_worktree and parent_project_path:
        sections.append(
            generate_worktree_isolation_warning(project_dir, parent_project_path)
        )

    # Resolve actual project root (parent if in worktree, otherwise project_dir itself)
    probe_dir = (
        parent_project_path if (is_worktree and parent_project_path) else project_dir
    )

    sections.append(f"""## YOUR ENVIRONMENT

**Working Directory:** `{project_dir}`
**Spec Location:** `{relative_spec}/`
{"**Isolation Mode:** WORKTREE (changes are isolated from main project)" if is_worktree else ""}

Your filesystem is restricted to your working directory. All file paths should be
relative to this location. Do NOT use absolute paths.

**⚠️ CRITICAL:** Before ANY git command or file operation, run `pwd` to verify your current
directory. If you've used `cd` to change directories, you MUST use paths relative to your
NEW location, not the working directory: after `cd apps/frontend`, it is `git add src/file.ts`,
not `git add apps/frontend/src/file.ts`. Prefer staying at the working directory root.

**Important Files:**
- Spec: `{relative_spec}/spec.md`
- Plan: `{relative_spec}/implementation_plan.json`
- Progress (blockers only, one line each): `{relative_spec}/build-progress.txt`
- Context: `{relative_spec}/context.json`

---

""")

    # Inject .NET build tools section if the project contains C#/F#/VB project files
    try:
        dotnet_section = generate_dotnet_env_section(probe_dir)
        if dotnet_section:
            sections.append(dotnet_section)
            sections.append("\n---\n\n")
    except Exception:
        pass  # Silently skip on any detection error

    return "".join(sections)


def _manual_verification_section(verification: dict) -> str:
    """The verification step of a ``manual`` (or unknown) verification.

    The agent runs the check itself whenever its tools can (read a file, run a
    command or the tests, in any language or stack). Only a check that needs a
    person (a device, an account, a judgement on a screen it cannot open)
    blocks the subtask, with a reason the person can act on: the subtask panel
    shows it next to the buttons that unblock it.
    """
    instructions = (
        verification.get("instructions")
        or verification.get("run")
        or verification.get("scenario")
        or "Check that the subtask's description is met."
    )
    return f"""**Verification:** {instructions}

1. Run this check yourself with your tools whenever you can: read the files,
   run the command, the build or the tests. Most checks can be run this way.
2. When it passes, set this subtask's status to "completed" in
   implementation_plan.json. When it fails, fix the cause, then check again.
3. Only when the check truly needs a person (a physical device, an account or
   credentials you do not have, a judgement on a screen you cannot open), set
   the status to "blocked" and add `"blocked_reason"`: one or two sentences,
   for that person, saying exactly what to check or provide. Never block a
   check you could run, and never ask a question and wait: the build goes on.
"""


def _human_reply_section(subtask: dict) -> str:
    """What the person answered when they sent this subtask back, if anything.

    The reply comes from the subtask panel (``foundation.subtask_unblock``):
    the person who owns the task wrote it, so it is an instruction, unlike
    the content of the repository.
    """
    reply = subtask.get("human_reply")
    if not isinstance(reply, str) or not reply.strip():
        if subtask.get("unblocked_at"):
            return (
                "## Sent back by the person\n\nThis subtask was blocked; the "
                "person asked you to try again. Use a different approach.\n"
            )
        return ""
    return f"""## Reply from the person

This subtask was blocked. The person answered, and sent it back to you:

> {reply.strip().replace(chr(10), chr(10) + "> ")}

Follow this answer. It overrides the earlier reason for the block.
"""


def generate_subtask_prompt(
    spec_dir: Path,
    project_dir: Path,
    subtask: dict,
    phase: dict,
    attempt_count: int = 0,
    recovery_hints: list[str] | None = None,
    human_input: str | None = None,
) -> str:
    """
    Generate a minimal, focused prompt for implementing a single subtask.

    Args:
        spec_dir: Directory containing spec files
        project_dir: Root project directory (working directory)
        subtask: The subtask to implement
        phase: The phase containing this subtask
        attempt_count: Number of previous attempts (for retry context)
        recovery_hints: Hints from previous failed attempts
        human_input: What the person wrote in ``HUMAN_INPUT.md``, as the
            orchestrator read it (it archives what it delivered); ``None``
            reads ``spec_dir``'s copy

    Returns:
        A focused prompt string (~100 lines instead of 900)
    """
    subtask_id = subtask.get("id", "unknown")
    description = subtask.get("description", "No description")
    service = subtask.get("service", "all")
    files_to_modify = subtask.get("files_to_modify", [])
    files_to_create = subtask.get("files_to_create", [])
    patterns_from = subtask.get("patterns_from", [])
    verification = subtask.get("verification", {})

    # Strict TDD (Red-Green-Refactor) applies only when enabled AND the subtask
    # is automatically testable. Otherwise we keep the classic implement->verify flow.
    tdd_active = is_tdd_enabled() and subtask_is_tdd_eligible(subtask, phase)

    # Get relative spec path
    get_relative_spec_path(spec_dir, project_dir)

    # Build the prompt
    sections = []

    # Environment context first
    sections.append(generate_environment_context(project_dir, spec_dir))

    # Header
    sections.append(f"""# Subtask Implementation Task

**Subtask ID:** `{subtask_id}`
**Phase:** {phase.get("name", phase.get("id", "Unknown"))}
**Service:** {service}

## Description

{description}
""")

    # What the person wrote after stopping the build (`foundation.human_input`).
    # First after the description: it is the most recent word on the task.
    instructions = human_input_section(
        read_human_input(spec_dir) if human_input is None else human_input
    )
    if instructions:
        sections.append(instructions)

    # TDD banner (only when strict TDD applies to this subtask)
    if tdd_active:
        sections.append("""
> 🔴🟢♻️ **TDD MODE: STRICT RED-GREEN-REFACTOR IS MANDATORY FOR THIS SUBTASK.**
> Write the test FIRST, watch it FAIL, then write the minimum code to make it PASS,
> then refactor. Production code may only be written to satisfy a failing test.
> Follow the **TDD Cycle** section below instead of the classic implement-then-verify flow.
""")

    # Recovery context if this is a retry
    if attempt_count > 0:
        sections.append(f"""
## ⚠️ RETRY ATTEMPT ({attempt_count + 1})

This subtask has been attempted {attempt_count} time(s) before without success.
You MUST use a DIFFERENT approach than previous attempts.
""")
        if recovery_hints:
            sections.append("**Previous attempt insights:**")
            for hint in recovery_hints:
                sections.append(f"- {hint}")
            sections.append("")

    reply = _human_reply_section(subtask)
    if reply:
        sections.append(reply)

    # What the worktree's recipe left undone, and the task's ports: read
    # before the first build, not discovered by it (core/workspace/recipe_run.py).
    from core.workspace.recipe_run import setup_prompt_section

    if setup := setup_prompt_section(project_dir):
        sections.append(setup)

    # Files section
    sections.append("## Files\n")

    if files_to_modify:
        sections.append("**Files to Modify:**")
        for f in files_to_modify:
            sections.append(f"- `{f}`")
        sections.append("")

    if files_to_create:
        sections.append("**Files to Create:**")
        for f in files_to_create:
            sections.append(f"- `{f}`")
        sections.append("")

    if patterns_from:
        sections.append("**Pattern Files (study these first):**")
        for f in patterns_from:
            sections.append(f"- `{f}`")
        sections.append("")

    # Stack-aware automated tests: tell the agent which kinds of tests the
    # touched files call for (API contract / WinForms UI / web E2E / unit),
    # using only the test libraries actually installed in the project.
    if (
        build_auto_test_instructions is not None
        and os.environ.get("AUTO_TEST_GENERATION", "").lower() != "false"
    ):
        try:
            auto_tests = build_auto_test_instructions(
                project_dir, [*files_to_modify, *files_to_create]
            )
        except Exception:
            auto_tests = None
        if auto_tests:
            sections.append(auto_tests)
            sections.append("")

    # Verification
    sections.append("## Verification\n")
    v_type = verification.get("type", "manual")

    if v_type == "command":
        sections.append(f"""Run this command to verify:
```bash
{verification.get("command", 'echo "No command specified"')}
```
Expected: {verification.get("expected", "Success")}
""")
    elif v_type == "api":
        method = verification.get("method", "GET")
        url = verification.get("url", "http://localhost")
        body = verification.get("body", {})
        expected_status = verification.get("expected_status", 200)
        sections.append(f"""Test the API endpoint:
```bash
curl -X {method} {url} -H "Content-Type: application/json" {f"-d '{json.dumps(body)}'" if body else ""}
```
Expected status: {expected_status}
""")
    elif v_type == "browser":
        url = verification.get("url", "http://localhost:3000")
        checks = verification.get("checks", [])
        sections.append(f"""Open in browser: {url}

Verify:""")
        for check in checks:
            sections.append(f"- [ ] {check}")
        sections.append("")
    elif v_type == "e2e":
        steps = verification.get("steps", [])
        sections.append("End-to-end verification steps:")
        for i, step in enumerate(steps, 1):
            sections.append(f"{i}. {step}")
        sections.append("")
    elif v_type == "none":
        sections.append(
            "No separate verification step: once the work in the description is "
            "done, mark the subtask completed.\n"
        )
    else:
        sections.append(_manual_verification_section(verification))

    # Instructions — TDD cycle when strict TDD applies, classic flow otherwise
    if tdd_active:
        sections.append(f"""## TDD Cycle (Red-Green-Refactor) — MANDATORY

Work strictly test-first. The command shown in the **Verification** section above is
your test command — run it at each RUN step.

1. 🔴 **RED — Write the failing test FIRST.**
   - Add/extend the test(s) that capture this subtask's behavior (the verification
     criterion and the description). Put them in the test file(s) for this service.
   - Do **NOT** write any production code yet.
2. 🔴 **RUN (expect red).** Run the verification/test command and **confirm it FAILS**.
   Paste the failing output. If the test already passes, it proves nothing — fix the
   test so it actually exercises the missing behavior.
3. 🟢 **GREEN — Write the minimum production code** to make the failing test pass.
   Stay within `files_to_modify` / `files_to_create`. No extra scope.
4. 🟢 **RUN (expect green).** Re-run the command and confirm **all tests pass**.
5. ♻️ **REFACTOR.** Clean up names/duplication while keeping the suite green.
   Re-run the command after refactoring to confirm it is still green.
6. **Commit test + implementation together:**
   ```bash
   git add .
   git commit -m "auto-claude: {subtask_id} - {description[:50]}"
   ```
7. **Update the plan** - set this subtask's status to "completed" in implementation_plan.json

## Quality Checklist

Before marking complete, verify:
- [ ] Test was written BEFORE the implementation and was proven to fail first (red)
- [ ] Implementation is the minimum needed to make the test pass (green)
- [ ] Follows patterns from reference files
- [ ] No console.log/print debugging statements
- [ ] Error handling in place
- [ ] Test suite passes after refactor
- [ ] Single clean commit containing both the test and the implementation

## Important

- Focus ONLY on this subtask - don't modify unrelated code
- NEVER write production code without a failing test that requires it
- If the test fails after implementation, FIX IT before committing
- If you hit a blocker, append ONE line to build-progress.txt (`[subtask-id] blocker: ...`)
- Never `git push`: the build is reviewed and merged by WorkPilot, not by you
- Never change git configuration (`git config`, `git -c`)
""")
    else:
        sections.append(f"""## Instructions

1. **Read the pattern files** to understand code style and conventions
2. **Read the files to modify** (if any) to understand current implementation
3. **Implement the subtask** following the patterns exactly
4. **Run verification** and fix any issues
5. **Commit your changes:**
   ```bash
   git add .
   git commit -m "auto-claude: {subtask_id} - {description[:50]}"
   ```
6. **Update the plan** - set this subtask's status to "completed" in implementation_plan.json

## Quality Checklist

Before marking complete, verify:
- [ ] Follows patterns from reference files
- [ ] No console.log/print debugging statements
- [ ] Error handling in place
- [ ] Verification passes
- [ ] Clean commit with descriptive message

## Important

- Focus ONLY on this subtask - don't modify unrelated code
- If verification fails, FIX IT before committing
- If you hit a blocker, append ONE line to build-progress.txt (`[subtask-id] blocker: ...`)
- Never `git push`: the build is reviewed and merged by WorkPilot, not by you
- Never change git configuration (`git config`, `git -c`)
""")

    # Note: Linear updates are now handled by Python orchestrator via linear_updater.py
    # Agents no longer need to call Linear MCP tools directly

    # Learning Loop: inject insights from previous builds
    try:
        from learning_loop.prompt_injection import get_learning_context

        learning_context = get_learning_context(project_dir, "coding")
        if learning_context:
            sections.append(learning_context)
    except Exception:
        pass

    return "\n".join(sections)


def generate_planner_prompt(spec_dir: Path, project_dir: Path | None = None) -> str:
    """
    Generate the planner prompt (used only once at start).
    This is a simplified version that focuses on plan creation.

    Args:
        spec_dir: Directory containing spec.md
        project_dir: Working directory (for relative paths)

    Returns:
        Planner prompt string
    """
    # Load the full planner prompt from file.
    candidate_dirs = [
        Path(__file__).parent.parent / "prompts",  # current layout
        Path(__file__).parent / "prompts",  # legacy fallback (if any)
    ]
    planner_file = next(
        (
            (candidate_dir / "planner.md")
            for candidate_dir in candidate_dirs
            if (candidate_dir / "planner.md").exists()
        ),
        None,
    )

    if planner_file:
        prompt = planner_file.read_text(encoding="utf-8")
    else:
        prompt = (
            "Read spec.md and create implementation_plan.json with phases and subtasks."
        )

    # Use project_dir for relative paths, or infer from spec_dir
    if project_dir is None:
        # Infer: spec_dir is typically project/auto-claude/specs/XXX
        project_dir = spec_dir.parent.parent.parent

    # Get relative path for spec directory
    relative_spec = get_relative_spec_path(spec_dir, project_dir)

    # Build header with environment context
    header = generate_environment_context(project_dir, spec_dir)

    # Add spec-specific instructions
    header += f"""## SPEC LOCATION

Your spec file is located at: `{relative_spec}/spec.md`

Store all build artifacts in this spec directory:
- `{relative_spec}/implementation_plan.json` - Subtask-based implementation plan
- `{relative_spec}/init.sh` - Environment setup script (only if missing)

The project root is your current working directory. Implement code in the project root,
not in the spec directory.

---

"""
    # Note: Linear task creation and updates are now handled by Python orchestrator
    # via linear_updater.py - agents no longer need Linear instructions in prompts

    # TDD addendum: when strict TDD mode is enabled, force a test-first plan.
    if is_tdd_enabled():
        prompt += _tdd_planner_addendum()

    # Learning Loop: inject insights from previous builds
    try:
        from learning_loop.prompt_injection import get_learning_context

        learning_context = get_learning_context(project_dir, "planning")
        if learning_context:
            prompt += "\n" + learning_context
    except Exception:
        pass

    return header + prompt


def _tdd_planner_addendum() -> str:
    """Instructions appended to the planner prompt when TDD_MODE is enabled.

    Forces a test-first plan: pre-implementation tests, test files listed in each
    implementation subtask, and a runnable `command` verification per subtask.
    """
    return """

---

## 🔴🟢♻️ TDD MODE ENABLED — PLAN TEST-FIRST (OVERRIDES DEFAULTS)

This project runs in **strict TDD (Red-Green-Refactor)** mode. Adjust the plan you
produce so the coding agent can work test-first:

1. **verification_strategy.test_creation_phase MUST be `"pre_implementation"`**
   (NOT `"post_implementation"`). Tests are written before the production code.
2. **Every implementation subtask is a self-contained TDD cycle.** Do NOT split
   "write the test" and "implement" into separate subtasks — the coding agent writes
   the failing test, then the code, within the same subtask.
3. **List the test file(s)** for each implementation subtask in `files_to_create`
   (new test files) or `files_to_modify` (existing test files), alongside the
   production files.
4. **Give each implementation subtask a runnable `command` verification** that
   executes *that subtask's* tests, e.g.:
   ```json
   "verification": {
     "type": "command",
     "command": "pytest tests/test_feature.py -q",
     "expected": "All tests pass"
   }
   ```
   Use the project's real test runner (pytest / npm test / vitest / etc. from
   project_index.json). Avoid `manual`/`none` verification for code subtasks.
5. **Mark TDD subtasks** by adding `"tdd": true` to each implementation subtask so
   the coder knows to enforce the red-green-refactor cycle.

Setup, investigation, cleanup, and purely manual/visual subtasks are exempt and keep
their normal verification. So is a subtask that only creates or edits plain text or
documentation (`.txt`, `.md`, `.rst`, README, LICENSE…): no test file, no `"tdd"`
flag — give it a one-line `command` verification that reads the file instead.
"""


def load_subtask_context(
    spec_dir: Path,
    project_dir: Path,
    subtask: dict,
    max_file_lines: int = 200,
) -> dict:
    """
    Load minimal context needed for a subtask.

    Args:
        spec_dir: Spec directory
        project_dir: Project root
        subtask: The subtask being implemented
        max_file_lines: Maximum lines to include per file

    Returns:
        Dict with file contents and relevant context
    """
    context = {
        "patterns": {},
        "files_to_modify": {},
        "spec_excerpt": None,
    }

    # Load pattern files (truncated)
    for pattern_path in subtask.get("patterns_from", []):
        full_path = project_dir / pattern_path
        if full_path.exists():
            try:
                lines = full_path.read_text(encoding="utf-8").split("\n")
                if len(lines) > max_file_lines:
                    content = "\n".join(lines[:max_file_lines])
                    content += (
                        f"\n\n... (truncated, {len(lines) - max_file_lines} more lines)"
                    )
                else:
                    content = "\n".join(lines)
                context["patterns"][pattern_path] = content
            except Exception:
                context["patterns"][pattern_path] = "(Could not read file)"

    # Load files to modify (truncated)
    for file_path in subtask.get("files_to_modify", []):
        full_path = project_dir / file_path
        if full_path.exists():
            try:
                lines = full_path.read_text(encoding="utf-8").split("\n")
                if len(lines) > max_file_lines:
                    content = "\n".join(lines[:max_file_lines])
                    content += (
                        f"\n\n... (truncated, {len(lines) - max_file_lines} more lines)"
                    )
                else:
                    content = "\n".join(lines)
                context["files_to_modify"][file_path] = content
            except Exception:
                context["files_to_modify"][file_path] = "(Could not read file)"

    return context


def format_context_for_prompt(context: dict) -> str:
    """
    Format loaded context into a prompt section.

    Args:
        context: Dict from load_subtask_context

    Returns:
        Formatted string to append to prompt
    """
    sections = []

    if context.get("patterns"):
        sections.append("## Reference Files (Patterns to Follow)\n")
        for path, content in context["patterns"].items():
            sections.append(f"### `{path}`\n```\n{content}\n```\n")

    if context.get("files_to_modify"):
        sections.append("## Current File Contents (To Modify)\n")
        for path, content in context["files_to_modify"].items():
            sections.append(f"### `{path}`\n```\n{content}\n```\n")

    return "\n".join(sections)
