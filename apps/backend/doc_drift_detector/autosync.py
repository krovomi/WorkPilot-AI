"""The drifts simple enough to fix without a model (#354).

- **rename**: a parameter renamed in the code is renamed in its doc comment;
- **retype**: a Python docstring's plain type is replaced by the annotation's;
- **path**: a cited file that moved is cited at its new place, when exactly
  one project file has its name.

Each fix is named by the id the scan gave it and made only if the drift is
still there in the folder it runs in (the review card's worktree): the scan
of the page may be older than the branch. A path is resolved and must stay
inside the project; a symbolic link is never written through.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from doc_languages import language_for

from .signatures import rename_in_doc, retype_in_doc, signature_drifts

__all__ = ["FixResult", "apply_fixes", "parse_fix_id"]

MAX_FIXES = 500
_ID = re.compile(
    r"^(?P<kind>rename|retype|path):(?P<file>[^\0:]{1,400}):(?P<line>\d{1,7}):(?P<a>[^\0:]{1,400}):(?P<b>[^\0:]{1,400})$"
)
_NAME = re.compile(r"^[A-Za-z_$][\w$]*$")
_TYPE = re.compile(r"^[A-Za-z_][\w.\[\], |]*$")


@dataclass
class FixResult:
    applied: list[dict[str, object]] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)


def parse_fix_id(fix_id: str) -> dict[str, str] | None:
    m = _ID.match(fix_id)
    if not m:
        return None
    parts = m.groupdict()
    if parts["kind"] == "rename" and not (
        _NAME.match(parts["a"]) and _NAME.match(parts["b"])
    ):
        return None
    if parts["kind"] == "retype" and not (
        _NAME.match(parts["a"]) and _TYPE.match(parts["b"])
    ):
        return None
    return parts


def _inside(root: Path, rel: str) -> Path | None:
    path = root / rel
    try:
        resolved = path.resolve()
    except OSError:
        return None
    if path.is_symlink() or not resolved.is_relative_to(root) or not resolved.is_file():
        return None
    return resolved


def _fix_rename(root: Path, parts: dict[str, str], text: str) -> str | None:
    line, old, new = int(parts["line"]), parts["a"], parts["b"]
    still = any(
        d.line == line and (old, new) in d.renamed
        for d in signature_drifts(parts["file"], text)
    )
    if not still:
        return None
    lang = language_for(parts["file"])
    return rename_in_doc(text, line, lang.id if lang else "", old, new)


def _fix_retype(root: Path, parts: dict[str, str], text: str) -> str | None:
    line, name, annotated = int(parts["line"]), parts["a"], parts["b"]
    for drift in signature_drifts(parts["file"], text):
        if drift.line != line:
            continue
        for param, documented, actual in drift.types:
            if param == name and actual == annotated:
                return retype_in_doc(text, line, name, documented, annotated)
    return None


def _fix_path(root: Path, parts: dict[str, str], text: str) -> str | None:
    line, ref, target = int(parts["line"]), parts["a"], parts["b"]
    if _inside(root, target) is None or (root / ref).exists():
        return None
    lines = text.split("\n")
    if not 0 < line <= len(lines):
        return None
    cited = f"`{ref}`"
    if cited not in lines[line - 1]:
        return None
    lines[line - 1] = lines[line - 1].replace(cited, f"`{target}`")
    return "\n".join(lines)


_FIXERS = {"rename": _fix_rename, "retype": _fix_retype, "path": _fix_path}


def apply_fixes(root: Path, fix_ids: list[str]) -> FixResult:
    """Make the fixes named, in ``root``; the ones no longer found are listed."""
    root = Path(root).resolve()
    result = FixResult()
    pending: dict[str, str] = {}
    for fix_id in list(dict.fromkeys(fix_ids))[:MAX_FIXES]:
        parts = parse_fix_id(fix_id)
        path = _inside(root, parts["file"]) if parts else None
        if parts is None or path is None:
            result.missing.append(fix_id)
            continue
        rel = parts["file"]
        if rel not in pending:
            try:
                # newline="": a CRLF file stays CRLF.
                with path.open(encoding="utf-8", newline="") as handle:
                    pending[rel] = handle.read()
            except (OSError, UnicodeDecodeError):
                result.missing.append(fix_id)
                continue
        updated = _FIXERS[parts["kind"]](root, parts, pending[rel])
        if updated is None or updated == pending[rel]:
            result.missing.append(fix_id)
            continue
        pending[rel] = updated
        result.applied.append(
            {
                "fixId": fix_id,
                "kind": parts["kind"],
                "file": rel,
                "line": int(parts["line"]),
            }
        )
    for rel in sorted({str(a["file"]) for a in result.applied}):
        path = _inside(root, rel)
        if path is None:
            continue
        with path.open("w", encoding="utf-8", newline="") as handle:
            handle.write(pending[rel])
    return result
