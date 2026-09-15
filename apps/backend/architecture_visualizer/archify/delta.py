"""What a task changed in the architecture — the Kanban's question.

The answer is one of six states, and five of them are not "here is a delta".
That ratio is the design: a card that always renders something is a card that
renders "nothing to report" most of the time, and the repository's own rule for
those is that they should render nothing at all.

Every state carries the sentence a person reads. `unreliable-ids` is the one
worth naming here: the comparator matches components by id, so an "after" model
that renamed them produces a delta that is entirely fictional. Reporting it as
unreliable costs a line; showing it costs the reader's trust in every future
one.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import cli
from . import ir as ir_module
from .runtime import check

logger = logging.getLogger(__name__)

#: Names under `<spec_dir>/architecture/`. The spec directory rather than the
#: worktree, deliberately: the worktree is removed when the task is merged, and
#: "what did this task change" is a question people ask after the merge.
SUBDIR = "architecture"
HEAD_SPEC = "head.arch.json"
DELTA_HTML = "delta.html"
DELTA_RECEIPT = "delta.receipt.json"
STATUS_FILE = "delta.status.json"

STATUS_MAPPED = "mapped"
STATUS_NOT_SIGNIFICANT = "not-significant"
STATUS_NO_BASELINE = "no-baseline"
STATUS_UNRELIABLE = "unreliable-ids"
STATUS_RUNTIME_MISSING = "runtime-missing"
STATUS_FAILED = "failed"


@dataclass
class DeltaStatus:
    """The whole answer, as it is written to disk and read by the UI."""

    status: str
    reason: str = ""
    baseline_revision: str | None = None
    head_revision: str | None = None
    summary: dict[str, Any] = field(default_factory=dict)
    continuity: dict[str, Any] = field(default_factory=dict)
    artifact: str | None = None
    receipt: str | None = None
    generated_at: str = ""

    @property
    def has_changes(self) -> bool:
        """Whether the comparison found anything at all.

        A mapped delta whose every counter is zero is a true answer to a
        question nobody needs answered, so the UI treats it exactly like
        `not-significant`.
        """
        if self.status != STATUS_MAPPED:
            return False
        return _count_changes(self.summary) > 0

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "reason": self.reason,
            "baselineRevision": self.baseline_revision,
            "headRevision": self.head_revision,
            "summary": self.summary,
            "continuity": self.continuity,
            "artifact": self.artifact,
            "receipt": self.receipt,
            "generatedAt": self.generated_at,
            "hasChanges": self.has_changes,
        }


def _count_changes(summary: dict[str, Any]) -> int:
    """Every counter in the receipt's summary, added up.

    Counted generically rather than field by field: archify's summary gained
    `moved`, `rerouted` and `geometryChanged` across versions, and a hard-coded
    list would silently report a new kind of change as no change.
    """
    total = 0
    for group in summary.values():
        if isinstance(group, dict):
            total += sum(v for v in group.values() if isinstance(v, int))
    return total


def directory(spec_dir: Path) -> Path:
    return spec_dir / SUBDIR


def status_path(spec_dir: Path) -> Path:
    return directory(spec_dir) / STATUS_FILE


def write_status(spec_dir: Path, status: DeltaStatus) -> DeltaStatus:
    from datetime import datetime, timezone

    if not status.generated_at:
        status.generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    target = status_path(spec_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(status.to_dict(), indent="\t") + "\n", encoding="utf-8"
    )
    return status


def read_status(spec_dir: Path) -> DeltaStatus | None:
    """The last recorded answer, or None when the task was never mapped."""
    target = status_path(spec_dir)
    if not target.is_file():
        return None
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.debug("unreadable delta status at %s", target)
        return None
    if not isinstance(raw, dict):
        return None
    return DeltaStatus(
        status=str(raw.get("status", STATUS_FAILED)),
        reason=str(raw.get("reason", "")),
        baseline_revision=raw.get("baselineRevision"),
        head_revision=raw.get("headRevision"),
        summary=raw.get("summary") or {},
        continuity=raw.get("continuity") or {},
        artifact=raw.get("artifact"),
        receipt=raw.get("receipt"),
        generated_at=str(raw.get("generatedAt", "")),
    )


def compare_models(
    spec_dir: Path,
    baseline_path: Path,
    head_path: Path,
    project_dir: Path,
) -> DeltaStatus:
    """Run the comparison, after establishing that it would mean anything."""
    readiness = check()
    if not readiness.ok:
        blockers = "; ".join(c.remedy or c.detail for c in readiness.blockers)
        return write_status(
            spec_dir,
            DeltaStatus(status=STATUS_RUNTIME_MISSING, reason=blockers),
        )

    try:
        baseline = ir_module.load(baseline_path)
        head = ir_module.load(head_path)
    except ir_module.IRError as exc:
        return write_status(
            spec_dir, DeltaStatus(status=STATUS_FAILED, reason=str(exc))
        )

    continuity = ir_module.check_id_continuity(baseline, head)
    if not continuity.reliable:
        return write_status(
            spec_dir,
            DeltaStatus(
                status=STATUS_UNRELIABLE,
                reason=(
                    f"the new model keeps only {continuity.kept} of "
                    f"{continuity.total} component identifiers, so a comparison "
                    "would report renames as removals"
                ),
                continuity=continuity.to_dict(),
                baseline_revision=_revision(baseline),
                head_revision=_revision(head),
            ),
        )

    out_dir = directory(spec_dir)
    receipt = cli.compare(
        base=baseline_path,
        head=head_path,
        output=out_dir / DELTA_HTML,
        receipt=out_dir / DELTA_RECEIPT,
        repo_root=project_dir,
    )
    if not receipt.ok:
        return write_status(
            spec_dir,
            DeltaStatus(
                status=STATUS_FAILED,
                reason=receipt.summary(),
                continuity=continuity.to_dict(),
            ),
        )

    summary = receipt.payload.get("summary")
    return write_status(
        spec_dir,
        DeltaStatus(
            status=STATUS_MAPPED,
            reason="",
            baseline_revision=_revision(baseline),
            head_revision=_revision(head),
            summary=summary if isinstance(summary, dict) else {},
            continuity=continuity.to_dict(),
            artifact=str(out_dir / DELTA_HTML),
            receipt=str(out_dir / DELTA_RECEIPT),
        ),
    )


def _revision(model: dict[str, Any]) -> str | None:
    repository = (model.get("meta") or {}).get("repository") or {}
    revision = repository.get("revision")
    return str(revision) if revision else None
