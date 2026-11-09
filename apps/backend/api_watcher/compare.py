"""Compare every API contract of a checkout with the target branch (#389).

The old version of a contract is read at the merge base of ``HEAD`` and the
target branch (`git show <base>:<path>`), the new one in the working tree, so
the comparison is the one a pull request makes: no saved baseline to keep up
to date. A task passes its change set (`files`) and only the contracts it
touched are read; the dashboard passes nothing and every contract is.

Each contract file is compared on its own (a monorepo with one contract per
service is compared service by service). A contract added is reported as
such; a contract deleted is a breaking change. RAML, WSDL and Thrift are only
compared as text, with a warning.
"""

from __future__ import annotations

import difflib
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import run_git

from .breaking_change_detector import (
    BreakingChangeDetector,
    ChangeCategory,
    ChangeType,
    ContractChange,
    ContractDiff,
)
from .consumers import Registry, find_references, group, load_registry, needles_for
from .contract_parser import ApiContract, ContractFormat, ContractParser
from .discover import contracts_among, discover, is_unsupported

MAX_CONTRACT_BYTES = 2 * 1024 * 1024
MAX_CONTRACTS = 60
_REF = re.compile(r"^[\w][\w./@{}~^-]{0,199}$")
TARGET_CANDIDATES = ("develop", "main", "master", "trunk")


@dataclass
class ContractReport:
    path: str
    format: str
    status: str  # changed | added | removed | unchanged | unsupported | unreadable
    old_version: str = ""
    new_version: str = ""
    diff: ContractDiff = field(default_factory=ContractDiff)
    consumers: dict[str, list[dict]] = field(default_factory=dict)
    text_delta: tuple[int, int] = (0, 0)

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "format": self.format,
            "status": self.status,
            "oldVersion": self.old_version,
            "newVersion": self.new_version,
            "changes": [
                _change_dict(c, self.consumers.get(c.path, []))
                for c in self.diff.changes
            ],
            "breakingCount": self.diff.breaking_count,
            "potentiallyBreakingCount": self.diff.potentially_breaking_count,
            "nonBreakingCount": self.diff.non_breaking_count,
            "unacknowledgedBreakingCount": len(self.diff.unacknowledged_breaking),
            "linesAdded": self.text_delta[0],
            "linesRemoved": self.text_delta[1],
        }


@dataclass
class CompareReport:
    base: str = ""
    target: str = ""
    contracts: list[ContractReport] = field(default_factory=list)
    unchecked: str = ""
    registry: Registry = field(default_factory=Registry)
    checked_at: str = ""

    @property
    def changes(self) -> list[ContractChange]:
        return [c for r in self.contracts for c in r.diff.changes]

    @property
    def unacknowledged_breaking(self) -> list[tuple[ContractReport, ContractChange]]:
        return [(r, c) for r in self.contracts for c in r.diff.unacknowledged_breaking]

    @property
    def status(self) -> str:
        if self.unchecked:
            return "unchecked"
        if self.unacknowledged_breaking:
            return "breaking"
        if any(
            c.category != ChangeCategory.NON_BREAKING or c.acknowledged
            for c in self.changes
        ) or any(r.status == "unsupported" for r in self.contracts):
            return "review"
        return "pass"

    def to_dict(self) -> dict:
        changes = self.changes
        return {
            "status": self.status,
            "base": self.base,
            "target": self.target,
            "unchecked": self.unchecked,
            "checkedAt": self.checked_at,
            "contracts": [r.to_dict() for r in self.contracts],
            "breakingCount": sum(
                c.category == ChangeCategory.BREAKING for c in changes
            ),
            "potentiallyBreakingCount": sum(
                c.category == ChangeCategory.POTENTIALLY_BREAKING for c in changes
            ),
            "nonBreakingCount": sum(
                c.category == ChangeCategory.NON_BREAKING for c in changes
            ),
            "unacknowledgedBreakingCount": len(self.unacknowledged_breaking),
            "registry": {
                "source": self.registry.source,
                "consumers": len(self.registry.consumers),
                "errors": self.registry.errors,
            },
        }


def _change_dict(change: ContractChange, consumers: list[dict]) -> dict:
    return {
        "changeType": change.change_type.value,
        "category": change.category.value,
        "path": change.path,
        "description": change.description,
        "oldValue": change.old_value,
        "newValue": change.new_value,
        "acknowledged": change.acknowledged,
        "consumers": consumers,
    }


def _git(root: Path, *args: str) -> str | None:
    result = run_git(list(args), cwd=root, timeout=30)
    return result.stdout if result.returncode == 0 else None


def valid_ref(ref: str) -> bool:
    """A ref the person typed: never an option, no path tricks."""
    return bool(_REF.match(ref)) and ".." not in ref


def resolve_base(root: Path, target: str = "") -> tuple[str, str]:
    """(merge base sha, target name), or ("", reason) when there is none."""
    if target and not valid_ref(target):
        return "", f"invalid target branch: {target[:60]}"
    if _git(root, "rev-parse", "--is-inside-work-tree") is None:
        return "", "not a git repository"
    candidates = [target] if target else []
    if not target:
        env = os.environ.get("DEFAULT_BRANCH", "").strip()
        if env and valid_ref(env):
            candidates.append(env)
        head = _git(
            root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"
        )
        if head and head.strip():
            candidates.append(head.strip().removeprefix("origin/"))
        candidates += list(TARGET_CANDIDATES)
    current = (_git(root, "rev-parse", "--abbrev-ref", "HEAD") or "").strip()
    for name in candidates:
        for ref in (f"origin/{name}", name):
            if not target and name == current and ref == name:
                continue  # the branch itself is no target
            sha = _git(root, "merge-base", ref, "HEAD")
            if sha and sha.strip():
                return sha.strip(), name
    return "", f"no target branch found ({', '.join(candidates[:5])})"


def _base_text(root: Path, base: str, path: str) -> str | None:
    size = _git(root, "cat-file", "-s", f"{base}:{path}")
    if size is None or not size.strip().isdigit() or int(size) > MAX_CONTRACT_BYTES:
        return None
    return _git(root, "show", f"{base}:{path}")


def _base_listing(root: Path, base: str) -> list[str]:
    listing = _git(root, "ls-tree", "-r", "--name-only", base) or ""
    return [line for line in listing.splitlines() if line]


def _read(root: Path, path: str) -> str | None:
    file = (root / path).resolve()
    try:
        file.relative_to(root.resolve())
    except ValueError:
        return None
    if (
        file.is_symlink()
        or not file.is_file()
        or file.stat().st_size > MAX_CONTRACT_BYTES
    ):
        return None
    try:
        return file.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _parse(parser: ContractParser, path: str, text: str) -> ApiContract:
    return parser.parse_string(text, ContractParser.detect_format(Path(path), text))


def _whole(contract: ApiContract, path: str, removed: bool) -> ContractDiff:
    diff = ContractDiff()
    if removed:
        diff.changes.append(
            ContractChange(
                ChangeType.CONTRACT_REMOVED,
                ChangeCategory.BREAKING,
                path,
                f"Contract {path} was deleted",
            )
        )
    else:
        diff.changes.append(
            ContractChange(
                ChangeType.CONTRACT_ADDED,
                ChangeCategory.NON_BREAKING,
                path,
                f"Contract {path} was added ({len(contract.endpoints)} endpoint(s))",
            )
        )
    diff.count()
    return diff


def compare(
    project_root: Path | str,
    *,
    target: str = "",
    base: str = "",
    files: list[str] | tuple[str, ...] | None = None,
    consumers: bool = True,
) -> CompareReport:
    """Every contract of ``project_root`` against the target branch."""
    root = Path(project_root).resolve()
    report = CompareReport(checked_at=datetime.now(UTC).isoformat(timespec="seconds"))
    if base:
        if not valid_ref(base):
            report.unchecked = "invalid base"
            return report
        report.base, report.target = base, target
    else:
        report.base, found = resolve_base(root, target)
        if not report.base:
            report.unchecked = found
            return report
        report.target = found

    if files is not None:
        candidates = contracts_among(
            files,
            lambda p: (_read(root, p) or _base_text(root, report.base, p) or "")[:4096],
        )
    else:
        old_paths = contracts_among(
            _base_listing(root, report.base),
            lambda p: (_base_text(root, report.base, p) or "")[:4096],
        )
        candidates = sorted(set(discover(root)) | set(old_paths))

    parser = ContractParser()
    detector = BreakingChangeDetector()
    for path in candidates[:MAX_CONTRACTS]:
        old_text = _base_text(root, report.base, path)
        new_text = _read(root, path)
        if old_text is None and new_text is None:
            continue
        if is_unsupported(path):
            delta = _text_delta(old_text or "", new_text or "")
            if delta != (0, 0):
                report.contracts.append(
                    ContractReport(
                        path,
                        Path(path).suffix.lstrip("."),
                        "unsupported",
                        text_delta=delta,
                    )
                )
            continue
        old = _parse(parser, path, old_text) if old_text is not None else None
        new = _parse(parser, path, new_text) if new_text is not None else None
        fmt = (new or old).format if (new or old) else ContractFormat.UNKNOWN
        if fmt == ContractFormat.UNKNOWN:
            continue
        if old is None and new is not None:
            entry = ContractReport(
                path, fmt.value, "added", "", new.version, _whole(new, path, False)
            )
        elif new is None and old is not None:
            entry = ContractReport(
                path, fmt.value, "removed", old.version, "", _whole(old, path, True)
            )
        else:
            diff = detector.diff(old, new)
            entry = ContractReport(
                path,
                fmt.value,
                "changed" if diff.changes else "unchanged",
                old.version,
                new.version,
                diff,
            )
        if entry.status != "unchanged":
            report.contracts.append(entry)

    if consumers and report.contracts:
        _attach_consumers(root, report, parser)
    return report


def _text_delta(old: str, new: str) -> tuple[int, int]:
    added = removed = 0
    for line in difflib.ndiff(old.splitlines(), new.splitlines()):
        if line.startswith("+ "):
            added += 1
        elif line.startswith("- "):
            removed += 1
    return added, removed


def _attach_consumers(
    root: Path, report: CompareReport, parser: ContractParser
) -> None:
    report.registry = load_registry(root)
    skip = {r.path for r in report.contracts}
    for entry in report.contracts:
        breaking = [
            c for c in entry.diff.changes if c.category != ChangeCategory.NON_BREAKING
        ]
        if not breaking:
            continue
        old_text = _base_text(root, report.base, entry.path) or ""
        old = _parse(parser, entry.path, old_text) if old_text else None
        operations = {e.key: e.operation_id for e in (old.endpoints if old else [])}
        needles = {c.path: needles_for(c.path, operations) for c in breaking}
        references = find_references(root, needles, skip)
        for change in breaking:
            concerned = group(
                references.get(change.path, []), entry.path, report.registry
            )
            if concerned:
                entry.consumers[change.path] = concerned


RECORD = "api_contract.json"


def write_record(spec_dir: Path | str, report: CompareReport) -> None:
    import json

    path = Path(spec_dir) / RECORD
    path.write_text(
        json.dumps(report.to_dict(), indent=2, ensure_ascii=False), encoding="utf-8"
    )


def load_record(spec_dir: Path | str) -> dict | None:
    import json

    path = Path(spec_dir) / RECORD
    if path.is_symlink() or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
