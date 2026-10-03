"""The design system a UI task builds against, settled before any code is written.

Runs once per build, between planning and coding (the `ui-design-system`
workflow phase), costs no token, and never fails a build: an absent engine, a
timeout, an unreadable file — each is recorded with its reason and the build
proceeds exactly as it would have without this module.

**One design system per project, not one per task.** The order is the point:

1. the project already has ``design-system/<slug>/MASTER.md`` (upstream's own
   convention) → that file is the design system, read and never rewritten;
2. otherwise one is generated from the task's description and, unless
   ``UIUX_PERSIST_MASTER=false``, written into the worktree by upstream's own
   ``--persist`` — without ``--force``. It lands in the task's diff, a person
   reviews it with the rest, and once merged every later UI task reads it in
   step 1 instead of generating a different palette.

Then the stack guidelines of the toolkit the task's UI files belong to are
added. Everything goes to ``<spec_dir>/uiux/``: ``result.json`` (what the card,
the prompt and the tool wiring read), ``design-system.md`` and
``guidelines.md``.

A ``MASTER.md`` is the project's file, which means somebody else may have
written it: it goes through ``injection_guard`` like an attachment, and one the
scanner blocks is withheld rather than put in front of a coder.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import engine
from .relevance import UIUX_DIR, Relevance, assess, task_description
from .runtime import doctor
from .settings import max_guidelines, persist_master

__all__ = [
    "MASTER_GLOB",
    "RESULT_FILE",
    "PreflightResult",
    "find_master",
    "read_result",
    "run_preflight",
]

logger = logging.getLogger(__name__)

RESULT_FILE = "result.json"
DESIGN_FILE = "design-system.md"
GUIDELINES_FILE = "guidelines.md"
MASTER_GLOB = "design-system/*/MASTER.md"
MAX_MASTER_CHARS = 20_000

_BANNER_RE = re.compile(r"^\s*(=+|✅|📄|📖)", re.M)
_NO_RESULTS_RE = re.compile(r"Found:\*\*\s*0\b|No results", re.I)
_GENERAL_STACK_QUERY = "accessibility layout forms state performance"


@dataclass
class PreflightResult:
    status: str  # ready | skipped | not-installed | failed | withheld
    relevance: Relevance
    source: str | None = None  # project | generated
    master_path: str | None = None  # relative to the project
    master_written: bool = False
    guide: str | None = None
    toolkit: str | None = None
    query: str | None = None
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "relevance": self.relevance.to_dict(),
            "source": self.source,
            "masterPath": self.master_path,
            "masterWritten": self.master_written,
            "guide": self.guide,
            "toolkit": self.toolkit,
            "query": self.query,
            "reasons": self.reasons,
            "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }


def _out_dir(spec_dir: Path) -> Path | None:
    out = Path(spec_dir) / UIUX_DIR
    if out.is_symlink() or Path(spec_dir).is_symlink():
        return None
    out.mkdir(parents=True, exist_ok=True)
    return out


def read_result(spec_dir: Path | str | None) -> dict[str, Any] | None:
    if not spec_dir:
        return None
    try:
        data = json.loads(
            (Path(spec_dir) / UIUX_DIR / RESULT_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def find_master(project_dir: Path | str | None) -> Path | None:
    """The project's own design system, when it has one. Links are not followed."""
    if not project_dir:
        return None
    root = Path(project_dir)
    base = root / "design-system"
    if not base.is_dir() or base.is_symlink():
        return None
    for path in sorted(root.glob(MASTER_GLOB)):
        if path.is_symlink() or path.parent.is_symlink():
            continue
        if path.is_file():
            return path
    return None


def _threat(text: str) -> str:
    try:
        from injection_guard import InjectionScanner

        return InjectionScanner().scan(text, source="design-system").threat_level.value
    except Exception:  # noqa: BLE001 - a scanner failure is not a verdict
        return "safe"


def _strip_banner(text: str) -> str:
    """Upstream follows the Markdown with a decorated "saved to" footer."""
    match = _BANNER_RE.search(text)
    return (text[: match.start()] if match else text).strip()


def _project_label(project_dir: Path) -> str:
    try:
        from brain.tasks import project_name

        name = project_name(project_dir)
    except Exception:  # noqa: BLE001
        name = Path(project_dir).name
    return name or "project"


def _query(description: str, project: str) -> str:
    """The first sentence of the task, else the project's name.

    Upstream's matcher is BM25 over product types and industries: the words a
    person used to describe the feature are the right input, and the model
    that could paraphrase them better is exactly what this module avoids.
    """
    first = re.split(r"(?<=[.!?\n])\s", description.strip(), maxsplit=1)[0]
    candidate = first[:160] if first.strip() else project
    try:
        return engine.clean_query(candidate)
    except ValueError:
        return engine.clean_query(project or "web application")


def _write(out: Path, name: str, text: str) -> None:
    target = out / name
    if target.is_symlink():
        return
    target.write_text(text.rstrip() + "\n", encoding="utf-8")


def _persist_target(project_dir: Path) -> Path | None:
    base = project_dir / "design-system"
    if base.is_symlink():
        return None
    return project_dir


def run_preflight(
    project_dir: Path | str,
    spec_dir: Path | str,
    *,
    planned_files: list[str] | None = None,
) -> PreflightResult:
    """Settle the design system for one task. Never raises."""
    project = Path(project_dir)
    spec = Path(spec_dir)
    relevance = assess(project, spec, planned_files=planned_files)
    result = PreflightResult(status="skipped", relevance=relevance)
    try:
        out = _out_dir(spec)
    except OSError as exc:
        result.status = "failed"
        result.reasons.append(f"spec directory not writable: {exc}")
        return result
    if out is None:
        result.status = "failed"
        result.reasons.append("spec directory is a symlink")
        return result

    try:
        _settle(project, spec, result)
    except Exception as exc:  # noqa: BLE001 - this module never fails a build
        logger.debug("uiux preflight failed: %s", exc, exc_info=True)
        result.status = "failed"
        result.reasons.append(str(exc))

    try:
        _write(
            out, RESULT_FILE, json.dumps(result.to_dict(), indent=1, ensure_ascii=False)
        )
    except OSError as exc:
        logger.debug("uiux result not written: %s", exc)
    return result


def _settle(project: Path, spec: Path, result: PreflightResult) -> None:
    out = spec / UIUX_DIR
    relevance = result.relevance
    if not relevance.is_ui:
        # A stale design system from an earlier verdict must not survive a
        # "skip": the prompt reads these files.
        for name in (DESIGN_FILE, GUIDELINES_FILE):
            try:
                (out / name).unlink()
            except FileNotFoundError:
                pass
        return

    health = doctor()
    if not health.installed:
        result.status = "not-installed"
        result.reasons.append(health.reason)
        return

    description = task_description(spec)
    label = _project_label(project)
    result.query = _query(description, label)

    design = ""
    master = find_master(project)
    if master is not None:
        text = master.read_text(encoding="utf-8", errors="replace")[:MAX_MASTER_CHARS]
        result.master_path = master.relative_to(project).as_posix()
        if _threat(text) == "blocked":
            result.status = "withheld"
            result.source = "project"
            result.reasons.append(
                "the project's MASTER.md was flagged by injection_guard and withheld"
            )
        else:
            result.source = "project"
            design = text
    else:
        target = _persist_target(project) if persist_master(project) else None
        try:
            generated = engine.design_system(result.query, label, persist_to=target)
        except (engine.EngineError, ValueError) as exc:
            result.status = "failed"
            result.reasons.append(str(exc))
            return
        result.source = "generated"
        written = find_master(project) if target is not None else None
        if written is not None:
            result.master_path = written.relative_to(project).as_posix()
            result.master_written = True
            design = written.read_text(encoding="utf-8", errors="replace")[
                :MAX_MASTER_CHARS
            ]
        else:
            design = _strip_banner(generated.text)

    if design:
        _write(out, DESIGN_FILE, design)

    kit = relevance.stack.guide_for(relevance.ui_files)
    if kit is not None:
        result.toolkit = kit.name
        result.guide = kit.guide
    guidelines = ""
    if kit is not None and kit.guide:
        # The task's own words first; a feature sentence often matches no
        # guideline row, and the stack's general rules are better than none.
        for query in (result.query, _GENERAL_STACK_QUERY):
            try:
                guidelines = engine.stack_guidelines(
                    query, kit.guide, n=max_guidelines(project)
                ).text
            except (engine.EngineError, ValueError) as exc:
                result.reasons.append(f"stack guidelines: {exc}")
                guidelines = ""
                break
            if guidelines and not _NO_RESULTS_RE.search(guidelines):
                break
    if guidelines and not _NO_RESULTS_RE.search(guidelines):
        _write(out, GUIDELINES_FILE, guidelines)
    else:
        try:
            (out / GUIDELINES_FILE).unlink()
        except FileNotFoundError:
            pass

    if result.status == "skipped":
        result.status = "ready"
