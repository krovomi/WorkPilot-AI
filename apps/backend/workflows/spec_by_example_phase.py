"""The `spec-by-example` phase: integration tests before code, for an ASP.NET Core API.

Plan of 29 October, IA6. On a task for an ASP.NET Core Web API, once the plan
is approved and before any code is written, one session writes the spec's
acceptance criteria as integration tests that go through HTTP
(`WebApplicationFactory<Program>`). Python then checks what it wrote and runs
it, and only a red run becomes the task's goal (`goal/`): ``dotnet test`` on
that project must exit 0, the tests written here are protected, and the QA
loop goes on until they pass.

The order of the checks is the order of what each rules out:

1. the session wrote only inside test projects (a ``.csproj`` that references
   a test SDK, or a solution file adding one): a test-first phase that edits
   the API has started the feature with nobody watching;
2. the tests compile: a build error is not a red test, and a goal that
   cannot build is met by nothing;
3. the run is red: tests green before any code describe nothing missing, and
   a goal they define is met already.

Off unless the project turns it on (``WORKPILOT_SPEC_BY_EXAMPLE``, the
project setting) or the task does (``specByExample`` in
``task_metadata.json``, which wins both ways). A task that already has a goal
keeps it: the definition of done is the person's, and this phase never
replaces one. Nothing here reverts a file: what the session wrote stays in
the worktree, in the diff a person reviews.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

ENV_SWITCH = "WORKPILOT_SPEC_BY_EXAMPLE"
METADATA_KEY = "specByExample"
ORIGIN = "spec-by-example"

AGENT_TYPE = "coder"
"""It writes test files and builds them: the coder's tools, told what it may touch."""

# What a test project references; one of them is enough.
_TEST_MARKERS = ("microsoft.net.test.sdk", "xunit", "nunit", "mstest")
_SOLUTION_SUFFIXES = (".sln", ".slnx")
_SKIPPED_DIRS = {".git", "bin", "obj", "node_modules", ".workpilot"}
_MAX_PROJECT_FILES = 200

# A build that failed, as `dotnet test` prints it: not a red test.
_BUILD_FAILED = re.compile(
    r"\berror (?:CS|MSB|NU)\d{4}\b|\bBuild FAILED\b", re.IGNORECASE
)

TEST_TIMEOUT_S = 900
MAX_PROTECTED = 64

# What opening the session can raise; a pause or a halt must go through.
_SESSION_ERRORS = (
    ImportError,
    OSError,
    RuntimeError,
    TimeoutError,
    TypeError,
    ValueError,
)


# ── Whether it runs ─────────────────────────────────────────────────────


def _metadata_switch(spec_dir: Path) -> bool | None:
    try:
        meta = json.loads((spec_dir / "task_metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = meta.get(METADATA_KEY) if isinstance(meta, dict) else None
    return value if isinstance(value, bool) else None


def enabled(spec_dir: Path) -> bool:
    """The task's ``specByExample`` when it says, else the project's switch."""
    task = _metadata_switch(spec_dir)
    if task is not None:
        return task
    return os.environ.get(ENV_SWITCH, "").strip().lower() in ("1", "true", "on")


# ── Test projects ───────────────────────────────────────────────────────


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def is_test_project(csproj: Path) -> bool:
    text = _read(csproj).lower()
    return any(marker in text for marker in _TEST_MARKERS)


def _csprojs(root: Path) -> list[Path]:
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIPPED_DIRS]
        found += [Path(dirpath) / f for f in filenames if f.endswith(".csproj")]
        if len(found) >= _MAX_PROJECT_FILES:
            break
    return sorted(found)


def test_projects(root: Path) -> list[Path]:
    """The test projects of the repository, those for HTTP tests first."""
    projects = [p for p in _csprojs(root) if is_test_project(p)]
    return sorted(
        projects,
        key=lambda p: "microsoft.aspnetcore.mvc.testing" not in _read(p).lower(),
    )


def owning_test_project(path: Path, root: Path) -> Path | None:
    """The test project whose directory holds `path`, or None."""
    directory = path.parent
    while True:
        for csproj in sorted(directory.glob("*.csproj")):
            if is_test_project(csproj):
                return csproj
        if directory == root or root not in directory.parents:
            return None
        directory = directory.parent


# ── What the session wrote ──────────────────────────────────────────────


def _git(cwd: Path, *args: str) -> tuple[int, str]:
    from foundation.git_executable import get_git_executable

    try:
        done = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [get_git_executable(), *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return done.returncode, done.stdout


def changed_paths(worktree: Path) -> dict[str, str] | None:
    """Every changed or new file, relative, with its content's hash; None if unknown.

    The hash, so a file that was already dirty and is then edited again still
    counts as written.
    """
    code, out = _git(
        worktree, "status", "--porcelain=v1", "-z", "--untracked-files=all"
    )
    if code != 0:
        return None
    paths: list[str] = []
    entries = out.split("\0")
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        status, path = entry[:2], entry[3:]
        if status[0] in "RC":
            index += 1  # the original name follows a rename or a copy
        paths.append(path)
    if not paths:
        return {}
    code, out = _git(
        worktree, "hash-object", "--", *[p for p in paths if (worktree / p).is_file()]
    )
    hashes = iter(out.split()) if code == 0 else iter(())
    return {
        path: (next(hashes, "") if (worktree / path).is_file() else "deleted")
        for path in paths
    }


def written_since(before: dict[str, str], after: dict[str, str]) -> list[str]:
    return sorted(path for path, digest in after.items() if before.get(path) != digest)


def classify(
    worktree: Path, paths: list[str]
) -> tuple[list[str], list[str], list[Path]]:
    """(test files, files outside any test project, test projects touched)."""
    root = worktree.resolve()
    tests: list[str] = []
    outside: list[str] = []
    projects: list[Path] = []
    for rel in paths:
        if rel.endswith(_SOLUTION_SUFFIXES) and "/" not in rel.strip("/"):
            continue  # adding the test project to the solution
        owner = owning_test_project((root / rel), root)
        if owner is None:
            outside.append(rel)
            continue
        tests.append(rel)
        if owner not in projects:
            projects.append(owner)
    return tests, outside, projects


# ── The goal ────────────────────────────────────────────────────────────


def goal_command(worktree: Path, projects: list[Path]) -> str | None:
    """``dotnet test`` on the one project the tests are in, or on the solution."""
    root = worktree.resolve()
    if len(projects) == 1:
        return f'dotnet test "{projects[0].relative_to(root).as_posix()}"'
    solutions = [p for p in root.iterdir() if p.suffix in _SOLUTION_SUFFIXES]
    if len(solutions) == 1:
        return f'dotnet test "{solutions[0].name}"'
    return None


def protected_paths(
    tests: list[str], projects: list[Path], worktree: Path
) -> list[str]:
    """The files written, or their projects' directories past the goal's cap."""
    files = [t for t in tests if not t.endswith(".csproj")]
    if len(files) <= MAX_PROTECTED:
        return files
    root = worktree.resolve()
    return [f"{p.parent.relative_to(root).as_posix()}/**/*.cs" for p in projects][
        :MAX_PROTECTED
    ]


def read_run(run) -> str:
    """``red``, ``green``, ``broken`` (no build) or ``error`` (no run)."""
    if run.status == "error" or run.exit_code is None:
        return "error"
    if run.exit_code == 0:
        return "green"
    if _BUILD_FAILED.search(run.output_tail or ""):
        return "broken"
    return "red"


def write_goal(spec_dirs: list[Path], command: str, protected: list[str]) -> list[Path]:
    """The goal in each spec directory, the way the card writes it. The ones written."""
    from goal.spec import DEFAULT_TIMEOUT_S, GOAL_FILENAME, parse_goal

    goal = {
        "command": command,
        "expectedExit": 0,
        "timeoutSeconds": max(DEFAULT_TIMEOUT_S, TEST_TIMEOUT_S),
        "protected": protected,
        "origin": ORIGIN,
    }
    parse_goal(goal)  # the goal gate must be able to read what is written
    written: list[Path] = []
    for directory in spec_dirs:
        path = directory / GOAL_FILENAME
        partial = path.with_name(f"{GOAL_FILENAME}.{os.getpid()}.tmp")
        try:
            partial.write_text(json.dumps(goal, indent=2) + "\n", encoding="utf-8")
            os.replace(partial, path)
        except OSError as exc:
            logger.warning(
                "spec by example: could not write the goal in %s: %s", directory, exc
            )
            continue
        written.append(path)
    return written


# ── The session ─────────────────────────────────────────────────────────


def build_prompt(ctx, projects: list[Path], libraries: str) -> str:
    spec_dir = Path(ctx.spec_dir)
    root = Path(ctx.project_dir).resolve()
    if projects:
        where = (
            "Write them in the existing test project "
            f"`{projects[0].relative_to(root).as_posix()}`"
            + (
                ""
                if "microsoft.aspnetcore.mvc.testing" in _read(projects[0]).lower()
                else ", adding a `Microsoft.AspNetCore.Mvc.Testing` package reference "
                "to its .csproj"
            )
            + "."
        )
    else:
        where = (
            "The solution has no test project: create one under `tests/` "
            "(`<Api>.IntegrationTests`, xUnit, referencing the API project and "
            "`Microsoft.AspNetCore.Mvc.Testing`) and add it to the solution."
        )
    return (
        "\n".join(
            [
                "# Spec by example: the integration tests first",
                "",
                (
                    "The plan for this task is approved and no code has been written "
                    "yet. Write the spec's acceptance criteria as integration tests "
                    "against the ASP.NET Core API, before the feature exists. They "
                    "become the task's definition of done: the build ends when "
                    "`dotnet test` passes on them."
                ),
                "",
                f"SPEC: {spec_dir / 'spec.md'} (read it first: one test per acceptance criterion)",
                f"PLAN: {spec_dir / 'implementation_plan.json'}",
                f"PROJECT DIRECTORY: {ctx.project_dir}",
                "",
                "## Rules",
                "",
                f"- {where}",
                "- Go through HTTP only: `WebApplicationFactory<Program>` and its "
                "`HttpClient`. Do not reference a type, a method or a file the feature "
                "has not created yet: the tests must compile today and fail because "
                "the behaviour is missing (404, wrong status, wrong body).",
                "- Change nothing outside the test project and the solution file. "
                "No controller, no endpoint, no model, no `Program.cs`: the coder "
                "writes the feature after you, against your tests.",
                "- Assert what the spec states: status codes, response bodies, "
                "headers. Not implementation details the spec does not name.",
                "- Build the test project (`dotnet build`) and fix what does not "
                "compile. Then run it once: the tests for the new behaviour must fail.",
                "- Never weaken a test to make it pass, and do not make any pass.",
                "",
                libraries,
            ]
        ).rstrip()
        + "\n"
    )


def _libraries(project_dir: Path) -> str:
    try:
        from test_generation.libraries import render_prompt_section, resolve_selection

        return render_prompt_section(resolve_selection(project_dir, "csharp"))
    except (ImportError, OSError, TypeError, ValueError) as exc:
        logger.debug("spec by example: no library selection: %s", exc)
        return ""


async def _session(ctx, prompt: str) -> tuple[str, str]:
    from agents.session import run_agent_session
    from core.client import create_agent_client
    from phase_config import get_phase_model, get_phase_thinking_budget
    from task_logger import LogPhase

    from .runner import phase_provider

    spec_dir = Path(ctx.spec_dir)
    explicit, _provider = phase_provider(spec_dir, "coding")
    stashed = os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
    try:
        client = create_agent_client(
            project_dir=Path(ctx.project_dir),
            spec_dir=spec_dir,
            model=get_phase_model(spec_dir, "coding", ctx.model),
            agent_type=AGENT_TYPE,
            max_thinking_tokens=get_phase_thinking_budget(spec_dir, "coding"),
            use_subagents=False,
            provider=explicit,
        )
        async with client:
            status, response, _err = await run_agent_session(
                client, prompt, spec_dir, ctx.verbose, phase=LogPhase.CODING
            )
        return status, response or ""
    finally:
        if stashed is not None:
            os.environ["AUTO_CLAUDE_RESUME_SESSION_ID"] = stashed


# ── The phase ───────────────────────────────────────────────────────────


async def run_spec_by_example_phase(resolved, ctx):
    """Write the acceptance criteria as red integration tests, then make them the goal."""
    from goal.check import run_goal
    from goal.gate import read_goal
    from goal.spec import GoalSpec
    from project.stack import detect_api_stack

    from .runner import PhaseOutcome, _write_output

    phase = resolved.phase

    def outcome(succeeded, detail, output_path=None):
        return PhaseOutcome(
            phase.id, phase.impl, resolved.dispatch, succeeded, detail, output_path
        )

    spec_dir = Path(ctx.spec_dir)
    source_spec_dir = getattr(ctx, "source_spec_dir", None)
    worktree = Path(ctx.project_dir)
    if not enabled(spec_dir):
        return outcome(None, "skipped: not turned on for this project or task")
    if detect_api_stack(worktree)[0] != "aspnetcore":
        return outcome(None, "skipped: not an ASP.NET Core project")
    goal, invalid = read_goal(spec_dir, source_spec_dir)
    if goal is not None or invalid is not None:
        return outcome(None, "skipped: the task already has a goal, which stays")
    before = changed_paths(worktree)
    if before is None:
        return outcome(None, "skipped: the worktree's changes cannot be read")

    print("  ↳ spec-by-example: writing the acceptance criteria as tests", flush=True)
    try:
        status, response = await _session(
            ctx, build_prompt(ctx, test_projects(worktree), _libraries(worktree))
        )
    except _SESSION_ERRORS as exc:  # a phase reports, it does not abort
        logger.warning("spec by example failed to run: %s", exc)
        return outcome(None, f"the session failed: {exc}"[:200])
    output_path = _write_output(ctx, phase.id, response)
    if status == "error":
        return outcome(False, "the session ended in an error", output_path)

    after = changed_paths(worktree)
    if after is None:
        return outcome(None, "the worktree's changes cannot be read", output_path)
    tests, outside, projects = classify(worktree, written_since(before, after))
    if outside:
        shown = ", ".join(outside[:5])
        return outcome(
            False,
            f"wrote outside the test projects ({shown}); no goal set, the files stay "
            "for review",
            output_path,
        )
    if not tests:
        return outcome(False, "no test was written; no goal set", output_path)
    command = goal_command(worktree, projects)
    if command is None:
        return outcome(
            None,
            "the tests span several projects and no single solution; no goal set",
            output_path,
        )

    run = run_goal(GoalSpec(command=command, timeout_s=TEST_TIMEOUT_S), worktree)
    state = read_run(run)
    if state == "error":
        return outcome(
            None, f"`{command}` could not run: {run.detail}; no goal set", output_path
        )
    if state == "broken":
        return outcome(False, "the tests do not compile; no goal set", output_path)
    if state == "green":
        return outcome(
            None,
            "the tests already pass, so they describe nothing missing; no goal set",
            output_path,
        )

    dirs = [spec_dir]
    if source_spec_dir is not None and Path(source_spec_dir) != spec_dir:
        dirs.insert(0, Path(source_spec_dir))
    protected = protected_paths(tests, projects, worktree)
    if not write_goal(dirs, command, protected):
        return outcome(None, "the goal could not be written", output_path)
    return outcome(
        True,
        f"{len(tests)} file(s) of red tests; goal set: `{command}` exits 0, "
        f"{len(protected)} path(s) protected",
        output_path,
    )
