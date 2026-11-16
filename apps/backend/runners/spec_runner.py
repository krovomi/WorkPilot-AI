#!/usr/bin/env python3
"""
Spec Creation Orchestrator
==========================

Dynamic spec creation with complexity-based phase selection.
The orchestrator uses AI to evaluate task complexity and adapts its process accordingly.

Complexity Assessment:
- The heuristic (spec/complexity.py) decides alone when it is confident
  (AI_ASSESSMENT_CONFIDENCE_THRESHOLD); otherwise the AI (complexity_assessor.md)
  settles it, considering scope, integrations, infrastructure, knowledge and risk
- Falls back to the heuristic verdict if AI assessment fails
- Use --no-ai-assessment to skip AI and use heuristics only

Complexity Tiers:
- SIMPLE (1-2 files): Discovery → Quick Spec → Validate (3 phases)
- STANDARD (3-10 files): Discovery → Requirements → Context → Spec → Plan → Validate (6 phases)
- STANDARD + Research: Same as above but with research phase for external dependencies (7 phases)
- COMPLEX (10+ files/integrations): Full 8-phase pipeline with research and self-critique

The AI considers:
- Number of files/services involved
- External integrations and research requirements
- Infrastructure changes (Docker, databases, etc.)
- Whether codebase has existing patterns to follow
- Risk factors and edge cases

Usage:
    python runners/spec_runner.py --task "Add user authentication"
    python runners/spec_runner.py --interactive
    python runners/spec_runner.py --continue 001-feature
    python runners/spec_runner.py --task "Fix button color" --complexity simple
    python runners/spec_runner.py --task "Simple fix" --no-ai-assessment
"""

import sys

# Python version check - must be before any imports using 3.12+ syntax
if sys.version_info < (3, 12):  # noqa: UP036
    sys.exit(
        f"Error: WorkPilot AI requires Python 3.12 or higher.\n"
        f"You are running Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}\n"
        f"\n"
        f"Please upgrade Python: https://www.python.org/downloads/"
    )

import asyncio
import json
import os
import subprocess
from pathlib import Path

# Add the backend to the path (parent of runners/)
sys.path.insert(0, str(Path(__file__).parent.parent))

# UTF-8 on Windows BEFORE any import that might print, piped (Electron) or not.
from ui.capabilities import configure_safe_encoding

configure_safe_encoding()

# Validate platform-specific dependencies BEFORE any imports that might
# trigger a pywintypes import (the MCP library imports win32api; ACS-253)
from core.dependency_validator import validate_platform_dependencies

validate_platform_dependencies()

# Load .env file with centralized error handling
from cli.utils import import_dotenv

load_dotenv = import_dotenv()

env_file = Path(__file__).parent.parent.parent.parent / ".env-files" / ".env"
dev_env_file = Path(__file__).parent.parent.parent / "dev" / "workpilot" / ".env"
if env_file.exists():
    load_dotenv(env_file)
elif dev_env_file.exists():
    load_dotenv(dev_env_file)

# Initialize Sentry early to capture any startup errors
from core.sentry import capture_exception, init_sentry

init_sentry(component="spec-runner")

from foundation.build_signals import BuildPaused
from foundation.debug import debug, debug_error, debug_section, debug_success
from foundation.platform import is_windows
from phase_config import resolve_model_id
from review import ReviewState
from spec import SpecOrchestrator
from ui import Icons, highlight, muted, print_section, print_status


def _continue_command(orchestrator: SpecOrchestrator) -> str:
    """The command that picks this spec up again, as it can be pasted."""
    return subprocess.list2cmdline(
        [
            "python",
            str(Path(__file__).resolve()),
            "--project-dir",
            str(orchestrator.project_dir),
            "--continue",
            orchestrator.spec_dir.name,
        ]
    )


def _project_root(project_dir: Path) -> Path:
    """The project a spec is for, from the folder the runner was started in.

    Started inside WorkPilot's own backend (``cd apps/backend``), the project
    is the repository around it; elsewhere it is the nearest folder with a
    ``.workpilot`` of its own, or the folder itself.
    """
    if (project_dir / "run.py").is_file() and (
        project_dir / "core" / "client.py"
    ).exists():
        for parent in project_dir.parents:
            if (parent / ".git").exists():
                return parent
    if (project_dir / ".workpilot").exists():
        return project_dir
    for parent in project_dir.parents:
        if (parent / ".workpilot").exists():
            return parent
    return project_dir


def main():
    """CLI entry point."""
    from integrations.jev.models import JevContext
    from integrations.jev.runtime import JevRun

    jev_run = JevRun.from_env(JevContext("feature-build", Path.cwd()))
    debug_section("spec_runner", "Spec Runner CLI")
    import argparse

    parser = argparse.ArgumentParser(
        description="Dynamic spec creation with complexity-based phase selection",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Complexity Tiers:
  simple    - 3 phases: Discovery → Quick Spec → Validate (1-2 files)
  standard  - 6 phases: Discovery → Requirements → Context → Spec → Plan → Validate
  complex   - 8 phases: Full pipeline with research and self-critique

Examples:
  # Simple UI fix (auto-detected as simple)
  python spec_runner.py --task "Fix button color in Header component"

  # Force simple mode
  python spec_runner.py --task "Update text" --complexity simple

  # Complex integration (auto-detected)
  python spec_runner.py --task "Add Redis caching to the user service"

  # Interactive mode
  python spec_runner.py --interactive
        """,
    )
    parser.add_argument(
        "--task",
        type=str,
        help="Task description (what to build). For very long descriptions, use --task-file instead.",
    )
    parser.add_argument(
        "--task-file",
        type=Path,
        help="Read task description from a file (useful for long specs)",
    )
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Run in interactive mode (gather requirements from user)",
    )
    parser.add_argument(
        "--continue",
        dest="continue_spec",
        type=str,
        help="Continue an existing spec",
    )
    parser.add_argument(
        "--complexity",
        type=str,
        choices=["simple", "standard", "complex"],
        help="Override automatic complexity detection",
    )
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=Path.cwd(),
        help="Project directory (default: current directory)",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="sonnet",
        help="Model to use for agent phases (haiku, sonnet, opus, or full model ID)",
    )
    parser.add_argument(
        "--thinking-level",
        type=str,
        default="medium",
        choices=["none", "low", "medium", "high", "ultrathink"],
        help="Thinking level for extended thinking (none, low, medium, high, ultrathink)",
    )
    parser.add_argument(
        "--no-ai-assessment",
        action="store_true",
        help="Use heuristic complexity assessment instead of AI (faster but less accurate)",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="Don't automatically start the build after spec creation (default: auto-start build)",
    )
    parser.add_argument(
        "--spec-dir",
        type=Path,
        help="Use existing spec directory instead of creating a new one (for UI integration)",
    )
    parser.add_argument(
        "--auto-approve",
        action="store_true",
        help="Skip human review checkpoint and automatically approve spec for building",
    )
    parser.add_argument(
        "--base-branch",
        type=str,
        default=None,
        help="Base branch for creating worktrees (default: auto-detect or current branch)",
    )
    parser.add_argument(
        "--direct",
        action="store_true",
        help="Build directly in project without worktree isolation (default: use isolated worktree)",
    )
    parser.add_argument(
        "--provider",
        type=str,
        default=None,
        help="LLM provider (anthropic, openai, copilot, google, mistral, deepseek, grok, meta, aws, ollama)",
    )

    args = parser.parse_args()

    # Warn user about direct mode risks
    if args.direct:
        print_status(
            "Direct mode: Building in project directory without worktree isolation",
            "warning",
        )

    # Handle task from file if provided
    task_description = args.task
    if args.task_file:
        try:
            task_description = args.task_file.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            print(f"Error: Task file not found: {args.task_file}")
            sys.exit(1)
        except (OSError, UnicodeDecodeError) as e:
            print(f"Error: Task file cannot be read: {args.task_file} ({e})")
            sys.exit(1)
        if not task_description:
            print(f"Error: Task file is empty: {args.task_file}")
            sys.exit(1)

    # Validate task description isn't problematic
    if task_description:
        # Warn about very long descriptions but don't block
        if len(task_description) > 5000:
            print(
                f"Warning: Task description is very long ({len(task_description)} chars). Consider breaking into subtasks."
            )
        # Sanitize null bytes which could cause issues
        task_description = task_description.replace("\x00", "")

    project_dir = _project_root(args.project_dir)

    # Propagate --provider to SELECTED_LLM_PROVIDER environment variable so that
    # _get_active_provider() picks it up throughout the entire spec creation pipeline
    # (AgentRunner, SpecOrchestrator, etc.) even when the frontend credential manager
    # did not inject it (e.g. settings.json.selectedProvider is null).
    # Anthropic is propagated too, as "claude": the task named it, and leaving
    # the variable alone would let the app's default provider — inherited from
    # Electron — run a spec the task asked Claude to write.
    provider = args.provider
    if provider and provider.lower() in ("anthropic", "claude"):
        provider = "claude"
    if provider:
        os.environ["SELECTED_LLM_PROVIDER"] = provider
        debug(
            "spec_runner",
            f"Injected SELECTED_LLM_PROVIDER={provider} into environment from --provider arg",
        )

    # Resolve the model the way every other phase does — provider-aware.
    #
    # This used to substitute the provider default ONLY when args.model was
    # still argparse's "sonnet", which meant any explicitly-passed model went
    # through untouched. The frontend always passes one (metadata.phaseModels.spec,
    # or metadata.model), so a task switched to Ollama while its saved spec model
    # was still a Claude id ran the whole spec pipeline as
    # `provider=ollama, model=claude-opus-4-5-…`: seven phases each asking the
    # local server for a model it cannot have, each falling back to pulling a
    # Claude manifest from the Ollama registry, each failing with
    # "pull model manifest: file does not exist".
    #
    # `_resolve_provider_model` is the shared resolver used by get_phase_model
    # for planning/coding/QA; routing the spec phase through it too means the
    # four phases finally agree on what "this provider's model" is.
    from phase_config import _resolve_provider_model

    if provider and provider != "claude":
        resolved_model = _resolve_provider_model(args.model, provider)
        if resolved_model != args.model:
            debug(
                "spec_runner",
                f"Model '{args.model}' is not valid for provider "
                f"'{provider}' — using the provider's model instead",
                resolved_model=resolved_model,
            )
    else:
        resolved_model = resolve_model_id(args.model)

    debug(
        "spec_runner",
        "Creating spec orchestrator",
        project_dir=str(project_dir),
        task_description=task_description[:200] if task_description else None,
        model=resolved_model,
        thinking_level=args.thinking_level,
        provider=args.provider,
        complexity_override=args.complexity,
        use_ai_assessment=not args.no_ai_assessment,
        interactive=args.interactive or not task_description,
        auto_approve=args.auto_approve,
    )

    orchestrator = SpecOrchestrator(
        jev_run=jev_run,
        project_dir=project_dir,
        task_description=task_description,
        spec_name=args.continue_spec,
        spec_dir=args.spec_dir,
        model=resolved_model,
        thinking_level=args.thinking_level,
        complexity_override=args.complexity,
        use_ai_assessment=not args.no_ai_assessment,
    )

    try:
        debug("spec_runner", "Starting spec orchestrator run...")
        success = asyncio.run(
            orchestrator.run(
                interactive=args.interactive or not task_description,
                auto_approve=args.auto_approve,
            )
        )

        if not success:
            debug_error("spec_runner", "Spec creation failed")
            sys.exit(1)

        debug_success(
            "spec_runner",
            "Spec creation succeeded",
            spec_dir=str(orchestrator.spec_dir),
        )

        # Auto-start build unless --no-build is specified
        if not args.no_build:
            debug("spec_runner", "Checking if spec is approved for build...")
            # Verify spec is approved before starting build (defensive check)
            review_state = ReviewState.load(orchestrator.spec_dir)
            if not review_state.is_approved():
                debug_error("spec_runner", "Spec not approved - cannot start build")
                print()
                print_status("Build cannot start: spec not approved.", "error")
                print()
                print(
                    f"  {muted('Approve it in the app (the task’s review), or here:')}"
                )
                print(f"  {highlight(_continue_command(orchestrator))}")
                sys.exit(1)

            debug_success("spec_runner", "Spec approved - starting build")
            print()
            print_section("STARTING BUILD", Icons.LIGHTNING)
            print()

            # Build the run.py command
            run_script = Path(__file__).parent.parent / "run.py"
            run_cmd = [
                sys.executable,
                str(run_script),
                "--spec",
                orchestrator.spec_dir.name,
                "--project-dir",
                str(orchestrator.project_dir),
                "--auto-continue",  # Non-interactive mode for chained execution
            ]

            # Bypass approval re-validation when all conditions are met:
            # 1. Spec was auto-approved (no human review required)
            # 2. Spec creation succeeded (we're past the success check above)
            # 3. No review-before-coding gate was requested
            # This prevents hash mismatch failures when spec files are
            # touched between auto-approval and run.py startup.
            if args.auto_approve:
                # Default to requiring review (fail-closed) - only skip if explicitly disabled
                require_review = True
                task_meta_path = orchestrator.spec_dir / "task_metadata.json"
                if task_meta_path.exists():
                    try:
                        with open(task_meta_path, encoding="utf-8") as f:
                            task_meta = json.load(f)
                        require_review = task_meta.get(
                            "requireReviewBeforeCoding", False
                        )
                    except (json.JSONDecodeError, OSError) as e:
                        # On parse error, keep require_review=True (fail-closed)
                        debug(
                            "spec_runner",
                            f"Failed to parse task_metadata.json, not adding --force: {e}",
                        )
                if not require_review:
                    run_cmd.append("--force")
                    debug(
                        "spec_runner",
                        "Adding --force: auto-approved, no review required, spec completed",
                    )

            # Pass base branch if specified (for worktree creation)
            if args.base_branch:
                run_cmd.extend(["--base-branch", args.base_branch])

            # Pass --direct flag if specified (skip worktree isolation)
            if args.direct:
                run_cmd.append("--direct")

            # Note: Model configuration for subsequent phases (planning, coding, qa)
            # is read from task_metadata.json by run.py, so we don't pass it here.
            # This allows per-phase configuration when using Auto profile.

            debug(
                "spec_runner",
                "Executing run.py for build",
                command=" ".join(run_cmd),
            )
            print(f"  {muted('Running:')} {' '.join(run_cmd)}")
            print()

            # Keep JEV credentials in the private runtime; never put them back
            # into an environment inherited by SDK tools or background servers.
            if jev_run.has_credential:
                from run import main as build_main

                build_main(argv=run_cmd[2:], jev_run=jev_run)
                sys.exit(0)

            # Execute run.py - use subprocess on Windows to maintain connection with Electron
            # Fix for issue #609: os.execv() breaks connection on Windows
            if is_windows():
                try:
                    result = subprocess.run(run_cmd)
                    sys.exit(result.returncode)
                except FileNotFoundError:
                    debug_error(
                        "spec_runner",
                        "Could not start coding phase - executable not found",
                    )
                    print_status(
                        "Could not start coding phase - executable not found", "error"
                    )
                    sys.exit(1)
                except OSError as e:
                    debug_error("spec_runner", f"Error starting coding phase: {e}")
                    print_status(f"Error starting coding phase: {e}", "error")
                    sys.exit(1)
                except KeyboardInterrupt:
                    debug_error("spec_runner", "Coding phase interrupted by user")
                    print("\n\nCoding phase interrupted.")
                    sys.exit(1)
            else:
                # On Unix/macOS, os.execv() works correctly - replaces current process
                os.execv(sys.executable, run_cmd)

        sys.exit(0)

    except BuildPaused:
        # The user paused during spec creation. Nothing failed, so this must not
        # exit non-zero: the frontend reads a non-zero exit as an unexpected
        # crash and moves the card out of its column, which is exactly what a
        # pause has to avoid. The pause flag stays on disk for the resume.
        print("\n\n⏸  Spec creation paused — resume from the Kanban, or:")
        print(f"   {_continue_command(orchestrator)}")
        sys.exit(0)
    except KeyboardInterrupt:
        debug_error("spec_runner", "Spec creation interrupted by user")
        print("\n\nSpec creation interrupted.")
        print(f"To continue: {_continue_command(orchestrator)}")
        sys.exit(1)
    except Exception as e:
        # Capture unexpected errors to Sentry
        capture_exception(
            e, spec_dir=str(orchestrator.spec_dir) if orchestrator else None
        )
        debug_error("spec_runner", f"Unexpected error: {e}")
        print(f"\n\nUnexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
