"""Requirement → subtask → files → tests, kept after the task (prospective P3).

When generating code costs little, the spec and the tests become the
reference and the implementation what gets regenerated. That needs a link the
pipeline did not keep: which code and which tests a requirement produced.
`traceability.json` stops at "this subtask claims FR-002"; the files live in
the session records, the tests in the repository's conventions, and all of it
lived in the task's spec folder.

`compute_links` joins the three halves at the end of a build:

* **requirement → subtasks**: the plan's references
  (`foundation.traceability.compute_coverage`);
* **subtask → files**: the files Agent Trace (F3) recorded for each session of
  that subtask, restricted to the task's real diff; a plan without session
  records falls back to the subtask's declared `files_to_modify` /
  `files_to_create`, and says so (``source: plan``);
* **files → tests**: the tests the repository's naming conventions point to,
  for every stack `foundation.touched_tests` maps (Python, TS/JS, .NET, JVM,
  Go, Rust, PHP, Swift, Dart, Ruby, Elixir, C/C++), plus the test files the
  subtask wrote itself.

`write_links` keeps the result next to the spec (`requirement-links.json`)
and in the project's ledger, `.workpilot/requirements/<spec>.json` in the
main checkout, which outlives the worktree and the task. `earlier_requirements`
reads the ledger back: the requirements of other tasks that touched the same
files, so a change that walks over earlier work says so before review. A
requirement whose files have no test is listed as such: it is the gap a
regeneration would fall into.

Nothing here is guessed: a link without evidence is absent, never inferred
from a title. Paths only, never code.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path

from foundation.git_executable import run_git
from foundation.touched_tests import is_mappable, is_test_file, map_tests
from foundation.traceability import compute_coverage, parse_requirements

logger = logging.getLogger(__name__)

__all__ = [
    "LEDGER_DIR",
    "LINKS_FILE",
    "compute_links",
    "earlier_requirements",
    "load_links",
    "write_links",
]

LINKS_FILE = "requirement-links.json"
LEDGER_DIR = Path(".workpilot") / "requirements"
VERSION = 1
MAX_FILES = 200
MAX_LEDGER = 500
_SPEC_NAME = re.compile(r"^[\w.-]{1,120}$")


def _json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _git_lines(cwd: Path, *args: str) -> list[str] | None:
    try:
        result = run_git(list(args), cwd=cwd, timeout=60)
    except (OSError, ValueError):
        return None
    if result.returncode != 0:
        return None
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _session_files(spec_dirs: list[Path]) -> dict[str, set[str]]:
    """Files each subtask's sessions wrote, from the Agent Trace records."""
    from agent_trace import read_records
    from agent_trace.record import METADATA_KEY

    for spec in spec_dirs:
        records = read_records(spec)
        if not records:
            continue
        by_subtask: dict[str, set[str]] = {}
        for record in records:
            meta = (record.get("metadata") or {}).get(METADATA_KEY) or {}
            subtask = meta.get("subtask_id")
            if not isinstance(subtask, str) or not subtask:
                continue
            for entry in record.get("files") or []:
                path = entry.get("path") if isinstance(entry, dict) else None
                if isinstance(path, str) and path:
                    by_subtask.setdefault(subtask, set()).add(path)
        return by_subtask
    return {}


def _plan_files(plan: dict | None) -> dict[str, set[str]]:
    """Files each subtask declared it would touch."""
    out: dict[str, set[str]] = {}
    for index, phase in enumerate((plan or {}).get("phases") or []):
        if not isinstance(phase, dict):
            continue
        for position, subtask in enumerate(phase.get("subtasks") or [], start=1):
            if not isinstance(subtask, dict):
                continue
            subtask_id = str(
                subtask.get("id") or f"phase-{index + 1}-subtask-{position}"
            )
            declared = [
                *(subtask.get("files_to_modify") or []),
                *(subtask.get("files_to_create") or []),
            ]
            out[subtask_id] = {f for f in declared if isinstance(f, str) and f}
    return out


def _first_spec(spec_dirs: list[Path]) -> Path | None:
    for spec in spec_dirs:
        if (spec / "spec.md").is_file():
            return spec
    return None


def compute_links(
    code_dir: Path | str,
    spec_dirs: list[Path | str],
    changed_files: list[str] | None = None,
) -> dict | None:
    """Each requirement's subtasks, files and tests; None without a spec with ids.

    ``spec_dirs``: the spec's copies, the most recent first. ``changed_files``:
    the task's real diff, when the caller knows it; the links keep only those.
    """
    code = Path(code_dir)
    specs = [Path(s) for s in spec_dirs if s]
    source_spec = _first_spec(specs)
    if source_spec is None:
        return None
    spec_text = _text(source_spec / "spec.md")
    plan = next(
        (p for p in (_json(s / "implementation_plan.json") for s in specs) if p),
        None,
    )
    requirements = parse_requirements(spec_text)
    if not requirements:
        return None
    coverage = compute_coverage(spec_text, plan)
    sessions = _session_files(specs)
    source = "agent-trace" if sessions else "plan"
    files_of = sessions or _plan_files(plan)
    changed = set(changed_files) if changed_files is not None else None
    repo_files = _git_lines(code, "ls-files") or []
    entries = []
    for requirement in requirements:
        subtasks = sorted(coverage.covered.get(requirement.id, ()))
        files = sorted(
            {
                f
                for s in subtasks
                for f in files_of.get(s, ())
                if changed is None or f in changed
            }
        )[:MAX_FILES]
        # Only a file a convention maps can be called untested: for a README
        # or a language no convention reads, nothing is known either way.
        sources = [f for f in files if is_mappable(f) and not is_test_file(f)]
        mapping, untested = map_tests(sources, repo_files)
        tests = sorted(
            {t for found in mapping.values() for t in found}
            | {f for f in files if is_test_file(f)}
        )
        entries.append(
            {
                "id": requirement.id,
                "title": requirement.title,
                "subtasks": subtasks,
                "files": files,
                "tests": tests,
                "untested": sorted(untested),
            }
        )
    head = _git_lines(code, "rev-parse", "HEAD")
    return {
        "version": VERSION,
        "spec": source_spec.name,
        "head": head[0] if head else "",
        "at": time.time(),
        "source": source,
        "requirements": entries,
    }


def _ledger(project_dir: Path) -> Path:
    folder = Path(project_dir).resolve() / LEDGER_DIR
    for step in (folder.parent, folder):
        if step.is_symlink():
            raise OSError(f"{step.name} is a link")
    return folder


def write_links(
    code_dir: Path | str,
    spec_dirs: list[Path | str],
    project_dir: Path | str,
    changed_files: list[str] | None = None,
) -> dict | None:
    """Compute the links, keep them beside each spec copy and in the project's
    ledger. Never raises: a build does not fail over its traceability."""
    try:
        links = compute_links(code_dir, spec_dirs, changed_files)
        if links is None:
            return None
        text = json.dumps(links, indent=2, ensure_ascii=False)
        for spec in dict.fromkeys(Path(s) for s in spec_dirs if s):
            if spec.is_dir():
                (spec / LINKS_FILE).write_text(text, encoding="utf-8")
        if _SPEC_NAME.fullmatch(links["spec"]):
            ledger = _ledger(Path(project_dir))
            ledger.mkdir(parents=True, exist_ok=True)
            target = ledger / f"{links['spec']}.json"
            if target.is_symlink():
                raise OSError("the ledger entry is a link")
            target.write_text(text, encoding="utf-8")
        return links
    except (OSError, ValueError) as exc:
        logger.warning("[requirement-trace] links not written: %s", exc)
        return None


def load_links(spec_dir: Path | str) -> dict | None:
    return _json(Path(spec_dir) / LINKS_FILE)


def earlier_requirements(
    project_dir: Path | str, files: list[str], exclude_spec: str = ""
) -> list[dict]:
    """The requirements of other tasks, from the ledger, that touched ``files``."""
    wanted = set(files)
    if not wanted:
        return []
    try:
        ledger = _ledger(Path(project_dir))
    except OSError:
        return []
    if not ledger.is_dir():
        return []
    found: list[dict] = []
    entries = sorted(ledger.glob("*.json"))[:MAX_LEDGER]
    for path in entries:
        if path.is_symlink() or path.stem == exclude_spec:
            continue
        links = _json(path)
        if not links:
            continue
        for requirement in links.get("requirements") or []:
            if not isinstance(requirement, dict):
                continue
            shared = sorted(wanted & set(requirement.get("files") or []))
            if shared:
                found.append(
                    {
                        "spec": str(links.get("spec") or path.stem),
                        "id": str(requirement.get("id") or ""),
                        "title": str(requirement.get("title") or ""),
                        "files": shared,
                        "tests": list(requirement.get("tests") or []),
                    }
                )
    return found
