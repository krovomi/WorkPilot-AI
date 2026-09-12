"""Where archify is, whether it can run here, and what is missing if not.

The doctor runs **before** the phase, not after the empty result. Every
condition below is answerable from files on disk in milliseconds, which is why
the Kanban can ask on every panel open and the workflow phase can ask before
spending a token. It is the same shape as `mobile/readiness.py` and
`hermes/readiness.py`, for the same reason: an agent told "generation failed"
goes looking for a code bug, and an agent told "node is not on PATH" does not.

Only `node` is a hard blocker. A missing baseline is a state the UI can offer to
fix; a missing runtime on a source checkout means somebody deleted the vendored
tree, and the remedy is one command.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from core.platform import find_executable

# `apps/backend/vendor/archify` — three parents up from this file
# (`archify/` -> `architecture_visualizer/` -> `apps/backend/`).
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
_VENDORED = _BACKEND_ROOT / "vendor" / "archify"

_ENV_HOME = "WORKPILOT_ARCHIFY_HOME"

#: Minimum Node the renderer declares in its own `package.json`.
NODE_MIN_MAJOR = 18


@dataclass(frozen=True)
class Condition:
    """One thing that must hold, and the sentence that fixes it when it does not."""

    name: str
    ok: bool
    detail: str = ""
    remedy: str = ""
    blocking: bool = False

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "remedy": self.remedy,
            "blocking": self.blocking,
        }


@dataclass(frozen=True)
class Readiness:
    """Whether archify can run in this checkout, and what is in the way."""

    ok: bool
    node: str | None
    archify_root: Path | None
    conditions: list[Condition] = field(default_factory=list)

    @property
    def blockers(self) -> list[Condition]:
        return [c for c in self.conditions if c.blocking and not c.ok]

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "node": self.node,
            "archifyRoot": str(self.archify_root) if self.archify_root else None,
            "conditions": [c.to_dict() for c in self.conditions],
        }


def archify_root() -> Path | None:
    """The directory holding `bin/archify.mjs`, or None when there is none.

    `$WORKPILOT_ARCHIFY_HOME` wins so a developer can point at a working clone
    while moving the pin, without touching the vendored tree the tests assert
    against.
    """
    override = os.environ.get(_ENV_HOME)
    candidates = [Path(override).expanduser()] if override else []
    candidates.append(_VENDORED)
    for candidate in candidates:
        if (candidate / "bin" / "archify.mjs").is_file():
            return candidate
    return None


def node_executable() -> str | None:
    """Node, found the cross-platform way. Never a hard-coded path."""
    return find_executable("node")


def _node_version(node: str) -> tuple[bool, str]:
    try:
        out = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"could not be run: {exc}"
    raw = (out.stdout or out.stderr).strip()
    try:
        major = int(raw.lstrip("v").split(".")[0])
    except (ValueError, IndexError):
        # An unparseable version is not a reason to refuse: the renderer will
        # say so far more precisely than a regex here can.
        return True, raw or "unknown"
    return major >= NODE_MIN_MAJOR, raw


def check() -> Readiness:
    """The three conditions, always all three, whatever the first one says.

    Reporting only the first failure means fixing it reveals the next one, one
    round-trip at a time. The card shows the list.
    """
    conditions: list[Condition] = []

    node = node_executable()
    if node is None:
        conditions.append(
            Condition(
                name="node",
                ok=False,
                detail="Node.js is not on PATH",
                remedy=f"install Node.js {NODE_MIN_MAJOR}+ and reopen the app",
                blocking=True,
            )
        )
        version_ok = False
    else:
        version_ok, raw = _node_version(node)
        conditions.append(
            Condition(
                name="node",
                ok=version_ok,
                detail=f"{raw} at {node}",
                remedy=(
                    ""
                    if version_ok
                    else f"archify requires Node.js {NODE_MIN_MAJOR}+; this is {raw}"
                ),
                blocking=True,
            )
        )

    root = archify_root()
    conditions.append(
        Condition(
            name="runtime",
            ok=root is not None,
            detail=str(root) if root else "bin/archify.mjs not found",
            remedy=(
                ""
                if root
                else "run `python3 scripts/vendor_archify.py` to restore the "
                "vendored renderer"
            ),
            blocking=True,
        )
    )

    ok = bool(node) and version_ok and root is not None
    return Readiness(ok=ok, node=node, archify_root=root, conditions=conditions)


# --------------------------------------------------------------------------- #
# Integrity of the vendored tree
# --------------------------------------------------------------------------- #

#: The receipt names itself, so it cannot be part of what it attests to.
RECEIPT_NAME = "VENDOR.json"


def file_digests(root: Path) -> dict[str, str]:
    """Every vendored file, by repository-relative path, with its sha256."""
    return {
        p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.name != RECEIPT_NAME
    }


def tree_digest(root: Path) -> str:
    """One hash over every vendored file's path and contents.

    Defined here rather than in `scripts/vendor_archify.py` because two places
    computing a digest is two answers to "is this tree the one it claims to
    be". The script writes it; the doctor and the contract test read it.

    Path and content both go in, so a renamed file with identical bytes still
    changes the digest. The receipt itself is excluded — it carries the result.
    """
    summary = hashlib.sha256()
    for relative, digest in file_digests(root).items():
        summary.update(f"{digest}  {relative}\n".encode())
    return summary.hexdigest()
