"""The public API of two builds of a .NET assembly, compared by REA (lot D).

REA's ``compare-managed-members`` pairs every method and field of two
assemblies, public or not, by declared type, name, signature and IL, without
loading either. Its items carry build-local metadata tokens and no visibility,
so each side is also read by ``inspect-managed-members``: the method and field
flags (ECMA-335 ``MemberAccessMask``) and the type flags along the nesting
chain say which members a consumer of the assembly can call.

What breaks a consumer:

* a public member gone (``removed``), or paired with a member that is no
  longer visible, or whose name, declaring type or signature changed (REA can
  pair members by IL shape across a rename);

What does not: a public member added, a body changed, anything non-public.

A side REA read only in part (capacity, malformed metadata), or a public member
REA could not pair (``ambiguous``), makes the diff ``unknown``, never
``compatible``: an empty list from a partial read is not an absence.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .locate import ReaLauncher, ReaUnavailable
from .runner import ReaRun, run_rea

__all__ = [
    "BREAKING",
    "COMPATIBLE",
    "UNKNOWN",
    "ApiChange",
    "ApiDiff",
    "public_api_diff",
    "visible_members",
]

BREAKING = "breaking"
COMPATIBLE = "compatible"
UNKNOWN = "unknown"

# ECMA-335 II.23.1.10 / II.23.1.5: Family (4), FamORAssem (5), Public (6).
_VISIBLE_MEMBER = {4, 5, 6}
# II.23.1.15: Public (1), NestedPublic (2), NestedFamily (4), NestedFamORAssem (7).
_VISIBLE_TYPE = {1, 2, 4, 7}
_MAX_CHANGES = 200


@dataclass(frozen=True)
class ApiChange:
    kind: str
    """``removed``, ``hidden``, ``signature``, ``renamed`` or ``added``."""
    member: str
    """``Namespace.Type.Member``, as REA named it."""
    detail: str = ""


@dataclass
class ApiDiff:
    status: str = UNKNOWN
    breaking: list[ApiChange] = field(default_factory=list)
    added: list[ApiChange] = field(default_factory=list)
    unknown: str = ""
    """Why nothing was decided, when ``status`` is unknown."""
    public_members: int = 0
    """Visible members of the left (older) side."""

    def to_dict(self) -> dict:
        return asdict(self)


def _int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def visible_members(inspection: dict) -> set[str] | None:
    """Tokens of the methods and fields a consumer can reach; None if unreadable."""
    types: dict[str, tuple[int, str | None]] = {}
    for row in inspection.get("types") or []:
        if not isinstance(row, dict) or not isinstance(row.get("token"), str):
            return None
        flags = _int(row.get("flags"))
        if flags is None:
            return None
        enclosing = row.get("enclosing_type_token")
        types[row["token"]] = (flags, enclosing if isinstance(enclosing, str) else None)

    def type_visible(token: str | None) -> bool:
        seen: set[str] = set()
        while token is not None:
            if token in seen or token not in types:
                return False  # a cycle or an unknown type is not proven visible
            seen.add(token)
            flags, enclosing = types[token]
            if flags & 0x7 not in _VISIBLE_TYPE:
                return False
            if flags & 0x7 in (2, 4, 7) and enclosing is None:
                return False  # nested, but its enclosing type was not read
            token = enclosing
        return True

    visible: set[str] = set()
    for collection in ("methods", "fields"):
        for row in inspection.get(collection) or []:
            if not isinstance(row, dict):
                return None
            flags = _int(row.get("flags"))
            token = row.get("token")
            if flags is None or not isinstance(token, str):
                return None
            parent = row.get("declaring_type_token")
            if flags & 0x7 in _VISIBLE_MEMBER and type_visible(
                parent if isinstance(parent, str) else None
            ):
                visible.add(f"{collection}:{token}")
    return visible


def _complete(inspection: dict) -> str:
    """ "" when REA read the whole member tables, else why not."""
    coverage = inspection.get("coverage")
    state = coverage.get("state") if isinstance(coverage, dict) else None
    metadata = inspection.get("metadata")
    meta = metadata.get("status") if isinstance(metadata, dict) else None
    if state != "complete" or meta != "complete":
        return f"REA read the assembly only in part (members {state}, metadata {meta})"
    if inspection.get("selection") is not None:
        return "REA read a selection of types, not the whole assembly"
    return ""


def _name(identity: object) -> str:
    if not isinstance(identity, dict):
        return "?"
    parent = identity.get("declaring_type") or "?"
    return f"{parent}.{identity.get('name') or '?'}"


def _compare(comparison: dict, left: set[str], right: set[str], diff: ApiDiff) -> str:
    """Fill ``diff`` from REA's pairing; "" or why the diff is unknown."""
    coverage = comparison.get("coverage")
    if (
        not isinstance(coverage, dict)
        or coverage.get("status") != "complete-within-inputs"
    ):
        return "REA's comparison is partial"
    for collection in ("methods", "fields"):
        for item in comparison.get(collection) or []:
            if not isinstance(item, dict):
                return "REA's comparison is unreadable"
            before, after = item.get("left"), item.get("right")
            match = item.get("match") if isinstance(item.get("match"), dict) else {}
            if before is None and after is None:
                # Ambiguous: several candidates on each side.
                candidates = match.get("candidate_left_tokens") or []
                if any(f"{collection}:{t}" in left for t in candidates):
                    return "REA could not pair some public members unambiguously"
                continue
            was = (
                isinstance(before, dict)
                and f"{collection}:{before.get('token')}" in left
            )
            now = (
                isinstance(after, dict)
                and f"{collection}:{after.get('token')}" in right
            )
            status = item.get("status")
            if status == "unknown" and (was or now):
                return "REA could not decide on some public members"
            if not was:
                if now and before is None:
                    diff.added.append(ApiChange("added", _name(after)))
                continue
            if after is None:
                diff.breaking.append(ApiChange("removed", _name(before)))
            elif not now:
                diff.breaking.append(ApiChange("hidden", _name(before)))
            elif (before.get("declaring_type"), before.get("name")) != (
                after.get("declaring_type"),
                after.get("name"),
            ):
                diff.breaking.append(
                    ApiChange("renamed", _name(before), detail=_name(after))
                )
            elif before.get("signature_sha256") != after.get("signature_sha256"):
                diff.breaking.append(ApiChange("signature", _name(before)))
    return ""


def public_api_diff(
    left: Path,
    right: Path,
    *,
    launcher: ReaLauncher | ReaUnavailable,
    project_dir: Path | None = None,
    runner: Callable[..., ReaRun] = run_rea,
    timeout: int = 600,
) -> ApiDiff:
    """What changed in the public API from ``left`` (before) to ``right``. Never raises."""
    diff = ApiDiff()
    if isinstance(launcher, ReaUnavailable):
        diff.unknown = f"REA cannot run here ({launcher.reason}): {launcher.detail}"
        return diff
    runs: list[ReaRun] = []
    for command, paths in (
        ("inspect-managed-members", [left]),
        ("inspect-managed-members", [right]),
        ("compare-managed-members", [left, right]),
    ):
        run = runner(
            command, paths, project_dir=project_dir, launcher=launcher, timeout=timeout
        )
        if not run.ok or run.result is None:
            diff.unknown = f"REA did not answer {command} ({run.error}): {run.detail}"[
                :400
            ]
            return diff
        runs.append(run)
    before, after, comparison = (r.result or {} for r in runs)
    for side in (before, after):
        partial = _complete(side)
        if partial:
            diff.unknown = partial
            return diff
    left_visible, right_visible = visible_members(before), visible_members(after)
    if left_visible is None or right_visible is None:
        diff.unknown = "REA's member tables are unreadable"
        return diff
    diff.public_members = len(left_visible)
    reason = _compare(comparison, left_visible, right_visible, diff)
    if reason:
        diff.breaking.clear()
        diff.added.clear()
        diff.unknown = reason
        return diff
    diff.breaking = diff.breaking[:_MAX_CHANGES]
    diff.added = diff.added[:_MAX_CHANGES]
    diff.status = BREAKING if diff.breaking else COMPATIBLE
    return diff
