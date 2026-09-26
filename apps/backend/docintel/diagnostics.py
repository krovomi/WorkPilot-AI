"""A crash or a red pipeline in an attachment, read down to the repository's files.

Two readers, one question — *where did it break?* — and neither is new:

| Reader | What it finds | Where it lives |
|---|---|---|
| stack traces | the frames, attached to this repository's files | `docintel/stacktrace.py` |
| CI logs | compiler/restore codes (`CS0103`, `NU1101`, `TS2345`, `E0425`…) and failing tests | `self_healing/incident_responder/cicd_mode.py` |

The CI parsers stay in `cicd_mode.py` — the incident model is where they were
needed first, and a second table here would drift from it the first time a
toolchain changes its output. They are imported on first use, so the MCP server
and the status endpoint never pay for the self-healing package.

Both run on text that has already been cleaned, secret-masked and scanned by
`injection_guard`: a diagnosis is read out of data, it is never a way around the
checks that data went through.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .stacktrace import RepoIndex, StackFrame, StackTrace, analyze, render_stacktrace
from .stacktrace import resolve_file as _resolve_file

logger = logging.getLogger(__name__)


def _cicd():
    """`cicd_mode`'s parsers, or None when the package cannot be imported here."""
    try:
        from self_healing.incident_responder import cicd_mode

        return cicd_mode
    except Exception:  # noqa: BLE001 - no CI reading is a reason, not a crash
        logger.debug("docintel: cicd parsers unavailable", exc_info=True)
        return None


def _repo_path(file: str, index: RepoIndex | None) -> str:
    """A path a CI runner printed (`/home/runner/work/app/src/x.cs`), in this repository."""
    if not file or index is None:
        return ""
    path, _match = _resolve_file(StackFrame(language="", file=file), index)
    return path


def read_ci(text: str, index: RepoIndex | None = None) -> dict | None:
    """Build errors and failing tests in `text`, or None when there are none."""
    cicd = _cicd()
    if cicd is None or not text:
        return None
    errors = cicd.parse_build_errors(text)
    failing = cicd.parse_failing_tests(text)
    if not errors and not failing:
        return None
    rows = []
    for error in errors:
        row = error.to_dict()
        row["path"] = _repo_path(error.file, index)
        rows.append(row)
    return {"errors": rows, "failing_tests": failing[:50]}


def diagnose(
    text: str, project_dir: Path | None, index: RepoIndex | None = None
) -> dict | None:
    """``{"stacktrace": …, "ci": …}`` for whatever `text` holds, or None. Never raises."""
    if not text:
        return None
    if index is None and project_dir is not None:
        index = RepoIndex(Path(project_dir))
    found: dict = {}
    try:
        if trace := analyze(text, project_dir, index):
            found["stacktrace"] = trace.to_dict()
    except Exception:  # noqa: BLE001
        logger.debug("docintel: stack trace reading failed", exc_info=True)
    try:
        if ci := read_ci(text, index):
            found["ci"] = ci
    except Exception:  # noqa: BLE001
        logger.debug("docintel: CI log reading failed", exc_info=True)
    return found or None


def render_ci(ci: dict, limit: int = 25) -> str:
    """Build errors and failing tests, repository paths where they were found."""
    lines: list[str] = []
    errors = [e for e in ci.get("errors") or [] if isinstance(e, dict)]
    if errors:
        lines.append("Build errors (code first):")
        for error in errors[:limit]:
            where = error.get("path") or error.get("file") or ""
            if where and error.get("line"):
                where = f"{where}:{error['line']}"
            code = error.get("code") or error.get("tool") or "error"
            location = f" `{where}`" if where else ""
            message = f" — {error['message']}" if error.get("message") else ""
            lines.append(f"- {code} ({error.get('tool', '')}){location}{message}")
        if len(errors) > limit:
            lines.append(f"- … {len(errors) - limit} more")
    failing = [str(t) for t in ci.get("failing_tests") or []]
    if failing:
        lines.append("Failing tests:")
        lines.extend(f"- {name}" for name in failing[:limit])
        if len(failing) > limit:
            lines.append(f"- … {len(failing) - limit} more")
    return "\n".join(lines)


def render_diagnosis(diagnosis: dict) -> tuple[str, str]:
    """(locations, quoted): what the readers established, and what the log says.

    Kept apart because they are trusted differently. The first is built from
    this repository's paths and from symbols that matched a character class; the
    second quotes messages somebody else's tool printed, and goes in a fence.
    """
    trusted = ""
    if isinstance(diagnosis.get("stacktrace"), dict):
        trusted = render_stacktrace(StackTrace.from_dict(diagnosis["stacktrace"]))
    quoted = render_ci(diagnosis["ci"]) if isinstance(diagnosis.get("ci"), dict) else ""
    return trusted, quoted


def summary(diagnosis: dict | None) -> dict | None:
    """The handful of numbers the Kanban card shows."""
    if not diagnosis:
        return None
    out: dict = {}
    trace = diagnosis.get("stacktrace")
    if isinstance(trace, dict):
        parsed = StackTrace.from_dict(trace)
        top = parsed.project_frames[0] if parsed.project_frames else None
        out["trace"] = {
            "exception": parsed.exception,
            "language": parsed.language,
            "projectFrames": len(parsed.project_frames),
            "frameworkFrames": parsed.framework_count,
            "top": (f"{top.path}:{top.line}" if top.line else top.path)
            if top
            else None,
        }
    ci = diagnosis.get("ci")
    if isinstance(ci, dict):
        errors = [e for e in ci.get("errors") or [] if isinstance(e, dict)]
        out["ci"] = {
            "errors": len(errors),
            "codes": list(
                dict.fromkeys(e.get("code") or e.get("tool") for e in errors)
            )[:5],
            "failingTests": len(ci.get("failing_tests") or []),
        }
    return out or None


def read_capture(path: Path, project_dir: Path | None):
    """A screenshot or log of a failed pipeline, read the way an attachment is.

    Same chain, same checks: OCR from `DOCINTEL_OCR_ENGINE` under the project's
    airgap policy, secrets masked, text scanned by `injection_guard`. Returns
    the `ExtractedDocument`; its `text` is what may be used, and a ``withheld``
    status for an injection means nothing of it may be.
    """
    from . import settings
    from .models import ExtractedDocument
    from .preflight import extract_file

    path = Path(path)
    if path.is_symlink() or not path.is_file():
        return ExtractedDocument(path=path.name, status="skipped", reason="unreadable")
    env = settings.project_env(project_dir)
    policy = tuple(Path(p) for p in (project_dir,) if p is not None)
    return extract_file(path, path.parent, env, policy_paths=policy, preview=False)
