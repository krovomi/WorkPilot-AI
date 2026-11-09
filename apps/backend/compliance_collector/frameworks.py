"""The compliance frameworks: their controls and the evidence each one needs (#357).

A framework is a YAML file: the four bundled ones (`catalog/`: SOC 2, ISO/IEC
27001:2022, HIPAA, PCI DSS 4.0), plus any the project versions in
`.workpilot/compliance/frameworks/*.yaml`. A project file with the id of a
bundled framework replaces it (a subset of controls, another numbering);
another id adds one (NIST, an internal policy). Each control lists what
evidence meets it, as requirements met by any of their kinds, and how old that
evidence may be at the end of the period.

A project file is read as data (S2): ``yaml.safe_load``, a size cap, every
field checked; a file that does not hold is skipped and named in ``errors``,
never trusted in part.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

__all__ = [
    "EVIDENCE_KINDS",
    "Control",
    "Framework",
    "load_frameworks",
    "parse_framework",
]

#: What `evidence.collect_evidence` finds; a control may only ask for these.
EVIDENCE_KINDS = (
    "spec_approval",
    "code_review",
    "tests",
    "security",
    "security_config",
    "change",
    "merge",
    "release",
    "deployment",
    "access",
    "policy",
    "procedure",
    "incident",
    "monitoring",
)

CATALOG = Path(__file__).parent / "catalog"
PROJECT_DIR = (".workpilot", "compliance", "frameworks")
MAX_FILE_BYTES = 256 * 1024
MAX_CONTROLS = 300
MAX_PROJECT_FILES = 20
_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_CONTROL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()/-]{0,59}$")


@dataclass(frozen=True)
class Control:
    id: str
    title: dict[str, str]
    requirements: tuple[tuple[str, ...], ...]
    """Each requirement is met by evidence of any of its kinds; all must be met."""
    max_age_days: int
    recommendation: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": dict(self.title),
            "requirements": [list(r) for r in self.requirements],
            "maxAgeDays": self.max_age_days,
            "recommendation": dict(self.recommendation),
        }


@dataclass(frozen=True)
class Framework:
    id: str
    name: str
    version: str
    controls: tuple[Control, ...]
    source: str
    """``bundled`` or the project file it came from."""

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "controls": len(self.controls),
            "source": self.source,
        }


def _text(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _words(value: Any, limit: int) -> dict[str, str]:
    """``{en, fr}`` (a plain string counts as English)."""
    if isinstance(value, str):
        value = {"en": value}
    if not isinstance(value, dict):
        return {}
    return {
        lang: _text(value.get(lang), limit)
        for lang in ("en", "fr")
        if _text(value.get(lang), limit)
    }


def _requirements(raw: Any) -> tuple[tuple[str, ...], ...]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("evidence must be a non-empty list")
    groups = []
    for group in raw:
        kinds = [group] if isinstance(group, str) else group
        if not isinstance(kinds, list) or not kinds:
            raise ValueError("each evidence requirement lists kinds")
        unknown = [k for k in kinds if k not in EVIDENCE_KINDS]
        if unknown:
            raise ValueError(f"unknown evidence kind: {unknown[0]!s:.40}")
        groups.append(tuple(dict.fromkeys(kinds)))
    return tuple(groups)


def _control(raw: Any) -> Control:
    if not isinstance(raw, dict):
        raise ValueError("a control is a mapping")
    control_id = raw.get("id")
    control_id = str(control_id) if isinstance(control_id, int | float) else control_id
    if not isinstance(control_id, str) or not _CONTROL_ID.match(control_id):
        raise ValueError("a control needs an id")
    title = _words(raw.get("title"), 160)
    if "en" not in title:
        raise ValueError(f"control {control_id} needs an English title")
    age = raw.get("max_age_days", 90)
    if isinstance(age, bool) or not isinstance(age, int) or not 1 <= age <= 3650:
        raise ValueError(f"control {control_id}: max_age_days is 1 to 3650")
    return Control(
        id=control_id,
        title=title,
        requirements=_requirements(raw.get("evidence")),
        max_age_days=age,
        recommendation=_words(raw.get("recommendation"), 400),
    )


def parse_framework(data: Any, source: str) -> Framework:
    """One framework from its YAML document; ValueError when it does not hold."""
    if not isinstance(data, dict):
        raise ValueError("a framework is a mapping")
    framework_id = data.get("id")
    if not isinstance(framework_id, str) or not _ID.match(framework_id):
        raise ValueError("a framework needs an id (a-z, 0-9, - and _)")
    raw_controls = data.get("controls")
    if not isinstance(raw_controls, list) or not raw_controls:
        raise ValueError(f"{framework_id}: no control")
    if len(raw_controls) > MAX_CONTROLS:
        raise ValueError(f"{framework_id}: more than {MAX_CONTROLS} controls")
    controls = tuple(_control(c) for c in raw_controls)
    if len({c.id for c in controls}) != len(controls):
        raise ValueError(f"{framework_id}: a control id appears twice")
    version = data.get("version", "")
    return Framework(
        id=framework_id,
        name=_text(data.get("name"), 80) or framework_id,
        version=_text(
            str(version) if isinstance(version, int | float) else version, 40
        ),
        controls=controls,
        source=source,
    )


def _project_files(project_root: Path) -> list[Path]:
    folder = project_root
    for part in PROJECT_DIR:
        folder = folder / part
        if folder.is_symlink():
            return []
    if not folder.is_dir():
        return []
    files = sorted(
        p
        for p in folder.iterdir()
        if p.suffix in (".yaml", ".yml") and p.is_file() and not p.is_symlink()
    )
    return files[:MAX_PROJECT_FILES]


def load_frameworks(
    project_root: Path | str | None = None,
) -> tuple[dict[str, Framework], list[str]]:
    """The frameworks by id, the project's over the bundled; and what was skipped."""
    frameworks: dict[str, Framework] = {}
    errors: list[str] = []
    for path in sorted(CATALOG.glob("*.yaml")):
        framework = parse_framework(
            yaml.safe_load(path.read_text(encoding="utf-8")), "bundled"
        )
        frameworks[framework.id] = framework
    if project_root is None:
        return frameworks, errors
    root = Path(project_root)
    for path in _project_files(root):
        rel = path.relative_to(root).as_posix()
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                raise ValueError("larger than 256 KB")
            framework = parse_framework(
                yaml.safe_load(path.read_text(encoding="utf-8")), rel
            )
        except (OSError, ValueError, yaml.YAMLError) as exc:
            errors.append(f"{rel}: {str(exc)[:200]}")
            continue
        frameworks[framework.id] = framework
    return frameworks, errors
