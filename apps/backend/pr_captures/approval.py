"""A person's "Publish" when the team reviews captures first (`CAPTURES_PUBLISH=review`).

The approval names the images that person saw (each side's signature in
`publication.json`), not the task: a capture taken again afterwards is a new
image and waits for a new "Publish".
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path

from docintel.visual_qa import CAPTURES_DIR

from .publication import load_publication

__all__ = ["APPROVAL_FILE", "approve", "approved_signatures", "revoke"]

APPROVAL_FILE = "approval.json"


def _path(spec_dir: Path | str) -> Path:
    return Path(spec_dir) / CAPTURES_DIR / APPROVAL_FILE


def approved_signatures(spec_dir: Path | str) -> set[str]:
    """The signatures a person published, empty when none."""
    try:
        data = json.loads(_path(spec_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    found = data.get("signatures") if isinstance(data, dict) else None
    return {s for s in found or [] if isinstance(s, str) and s}


def approve(spec_dir: Path | str) -> int:
    """Approve every publishable copy of the current publication; how many."""
    publication = load_publication(spec_dir) or {}
    signatures: list[str] = []
    for item in publication.get("items") or []:
        if not isinstance(item, dict):
            continue
        for side in ("after", "before"):
            entry = item.get(side)
            if isinstance(entry, dict) and entry.get("publishable"):
                signature = str(entry.get("signature") or "")
                if signature and signature not in signatures:
                    signatures.append(signature)
    target = _path(spec_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(f".{target.name}.partial")
    partial.write_text(
        json.dumps(
            {
                "approvedAt": datetime.now(UTC).isoformat(timespec="seconds"),
                "signatures": signatures,
            }
        ),
        encoding="utf-8",
    )
    os.replace(partial, target)
    return len(signatures)


def revoke(spec_dir: Path | str) -> None:
    """Forget the approval: the captures go back to waiting."""
    _path(spec_dir).unlink(missing_ok=True)
