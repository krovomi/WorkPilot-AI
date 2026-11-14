"""Did a change to a WinDev project touch only what an agent can write?

An agent edits WLangage code. It cannot produce what the editor writes around
that code: the base64 ``internal_properties`` of a window, a control or the
project, the ``identifier`` of an element, a binary element. A file where one
of those changed, appeared or vanished may no longer open in WinDev, and
nothing outside the editor can tell. So this check compares each changed file
with its version before the task and says what it can prove:

* a binary WinDev file (native format, analysis, query, test scenario, HFSQL
  data) was modified, created or deleted;
* a text element was created or deleted (an element is created in the editor,
  which registers it in the project);
* an element lost the text-format header, or its ``info`` (name, version,
  type) changed;
* an ``internal_properties`` or ``identifier`` value is new, or one that
  existed is gone (a control or an element was invented or removed);
* a ``procedure_id`` is duplicated, or not a number;
* the file parsed as YAML before and does not any more (some files the editor
  writes are not valid YAML: those are not judged on this point).

Each finding is a fact read from the two versions, never a guess: a problem
here is a reason to block. What it does not check is whether the code
compiles; that needs the editor.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from .files import (
    BINARY_ONLY_EXTENSIONS,
    DATA_EXTENSIONS,
    ELEMENT_KINDS,
    TEXT_CAPABLE_EXTENSIONS,
    sniff_format,
)
from .text_format import parse_text_element

__all__ = ["FileChange", "Problem", "IntegrityReport", "check_change", "check_changes"]


@dataclass(frozen=True)
class FileChange:
    """One changed path and its bytes before and after (None: absent)."""

    path: str
    before: bytes | None
    after: bytes | None


@dataclass(frozen=True)
class Problem:
    path: str
    rule: str
    detail: str


@dataclass
class IntegrityReport:
    checked: list[str] = field(default_factory=list)
    problems: list[Problem] = field(default_factory=list)
    code_lines_changed: int = 0

    @property
    def ok(self) -> bool:
        return not self.problems


def _yaml_parses(text: str) -> bool:
    try:
        import yaml
    except ImportError:  # pragma: no cover - PyYAML is a backend dependency
        return True
    try:
        yaml.safe_load(text)
    except yaml.YAMLError:
        return False
    return True


def _decode(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def _binary(change: FileChange, suffix: str) -> bool:
    """Whether the element is binary on either side of the change.

    A text element whose header an agent removed is still a text element (the
    header rule reports it): only a native side, or no text side at all, makes
    the change a binary one.
    """
    if suffix in BINARY_ONLY_EXTENSIONS or suffix in DATA_EXTENSIONS:
        return True
    formats = [
        sniff_format(s[:96]) for s in (change.before, change.after) if s is not None
    ]
    return "native" in formats or "text" not in formats


def check_change(change: FileChange) -> list[Problem]:
    """The problems one changed path shows; [] for a path outside WinDev."""
    suffix = PurePosixPath(change.path).suffix.lower()
    if suffix not in ELEMENT_KINDS and suffix not in DATA_EXTENSIONS:
        return []
    path = change.path
    if change.before == change.after:
        return []
    if _binary(change, suffix):
        verb = (
            "created"
            if change.before is None
            else "deleted"
            if change.after is None
            else "modified"
        )
        return [
            Problem(
                path,
                "binary-element",
                f"binary WinDev file {verb}: only the WinDev editor can write it",
            )
        ]
    if suffix not in TEXT_CAPABLE_EXTENSIONS:  # pragma: no cover - tables agree
        return []
    if change.before is None:
        return [
            Problem(
                path,
                "element-created",
                "new element written outside the editor: create it in WinDev, "
                "which registers it in the project",
            )
        ]
    if change.after is None:
        return [
            Problem(
                path,
                "element-deleted",
                "element deleted outside the editor: the project still lists it",
            )
        ]
    before_text, after_text = _decode(change.before), _decode(change.after)
    before, after = parse_text_element(before_text), parse_text_element(after_text)
    problems: list[Problem] = []
    if not after.header_ok:
        problems.append(
            Problem(
                path, "header", "the text-format header line was changed or removed"
            )
        )
    if (before.name, before.major_version, before.element_type) != (
        after.name,
        after.major_version,
        after.element_type,
    ):
        problems.append(
            Problem(path, "info", "the element's info (name, version, type) changed")
        )
    for key in ("internal_properties", "identifier"):
        added = after.opaque[key] - before.opaque[key]
        removed = before.opaque[key] - after.opaque[key]
        if added:
            problems.append(
                Problem(
                    path,
                    f"{key}-written",
                    f"{sum(added.values())} {key} value(s) not produced by the editor",
                )
            )
        if removed:
            problems.append(
                Problem(
                    path,
                    f"{key}-removed",
                    f"{sum(removed.values())} {key} value(s) removed: a control or an "
                    "element was deleted outside the editor",
                )
            )
    ids: Counter[str] = after.opaque["procedure_id"]
    if bad := sorted(v for v in ids if not v.isdigit()):
        problems.append(
            Problem(
                path, "procedure_id", f"procedure_id not a number: {', '.join(bad)}"
            )
        )
    if dup := sorted(v for v, n in ids.items() if n > 1):
        problems.append(
            Problem(path, "procedure_id", f"procedure_id used twice: {', '.join(dup)}")
        )
    if _yaml_parses(before_text) and not _yaml_parses(after_text):
        problems.append(
            Problem(
                path,
                "yaml",
                "the file no longer parses: a code block's indentation or its "
                "`code : |1+` header was broken",
            )
        )
    return problems


def _code_lines(change: FileChange) -> int:
    """Lines of WLangage that differ between the two versions of a text element."""
    sides = []
    for data in (change.before, change.after):
        if data is None or sniff_format(data[:96]) != "text":
            sides.append(Counter())
            continue
        element = parse_text_element(_decode(data))
        sides.append(
            Counter(
                line for block in element.blocks for line in block.code.splitlines()
            )
        )
    before, after = sides
    return sum((after - before).values()) + sum((before - after).values())


def check_changes(changes: list[FileChange]) -> IntegrityReport:
    """Every problem across ``changes``, and how many code lines they touch."""
    report = IntegrityReport()
    for change in changes:
        suffix = PurePosixPath(change.path).suffix.lower()
        if suffix not in ELEMENT_KINDS and suffix not in DATA_EXTENSIONS:
            continue
        report.checked.append(change.path)
        report.problems.extend(check_change(change))
        report.code_lines_changed += _code_lines(change)
    return report
