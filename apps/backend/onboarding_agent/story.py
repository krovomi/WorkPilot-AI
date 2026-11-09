"""The code's story: a tour per role, five chapters, and when it goes stale (#349).

On top of the deterministic package (tour, quiz, first tasks, glossary):

- **roles**: every tour step, hot spot and directory gets an *area* (``ui``,
  ``api``, ``data``, ``infra``, ``docs``, ``tests`` or ``general``) from its
  path, the same way on every stack. A frontend tour keeps the ``ui`` steps,
  a backend tour ``api`` and ``data``, a DevOps tour ``infra``; each keeps the
  general steps (README, entry points, configuration). Full stack is the
  whole tour;
- **chapters**, in the order a colleague would tell them: how the project is
  laid out (by stack when it has several), where it starts, its most critical
  module, its fragile zones, and what the team decided;
- **freshness**: a fingerprint of the modules (folders with code, two levels
  deep) and the manifests. The last tour's is kept in
  ``.workpilot/onboarding/tour.json``; a new or removed module makes the tour
  stale, and the page regenerates it;
- **quiz**: two questions from the hot spots and danger zones.

No model is called here. ``narrate.py`` can tell the chapters in prose.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from .decisions import Decision, read_decisions
from .hotspots import Hotspot, analyse_hotspots
from .messages import Text, raw, text
from .tour_builder import QuizQuestion, TourStep, _make_question

logger = logging.getLogger(__name__)

__all__ = [
    "AREAS",
    "ROLES",
    "Chapter",
    "Story",
    "area_of",
    "build_chapters",
    "build_story",
    "fingerprint",
    "freshness",
    "role_tours",
    "save_fingerprint",
    "story_quiz",
]

ROLES = ("fullstack", "frontend", "backend", "devops")
AREAS = ("ui", "api", "data", "infra", "docs", "tests", "general")
_ROLE_AREAS = {
    "frontend": {"ui"},
    "backend": {"api", "data"},
    "devops": {"infra"},
}

_AREA_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "tests",
        re.compile(
            r"(?:^|/)(?:tests?|__tests__|spec|e2e|cypress|playwright)/|[._-](?:test|spec)\.\w+$|Tests?\.\w+$",
            re.I,
        ),
    ),
    (
        "infra",
        re.compile(
            r"(?:^|/)(?:\.github|\.gitlab|\.circleci|\.azure|ci|deploy|deployment|infra|infrastructure|terraform|"
            r"helm|charts|k8s|kubernetes|ansible|docker|ops)(?:/|$)|(?:^|/)(?:Dockerfile|docker-compose[^/]*|"
            r"Jenkinsfile|azure-pipelines\.yml|\.gitlab-ci\.yml|Makefile|Procfile|\w+\.tf)$",
            re.I,
        ),
    ),
    (
        "data",
        re.compile(
            r"(?:^|/)(?:migrations?|alembic|db|database|data|models?|entities|entity|repositories|repository|"
            r"persistence|schema|prisma|sql|Migrations|Entities|Models|Data|Repositories)(?:/|$)|\.(?:sql|prisma)$"
        ),
    ),
    (
        "ui",
        re.compile(
            r"(?:^|/)(?:components?|pages?|views?|screens?|layouts?|ui|widgets|templates|styles?|css|assets|"
            r"public|static|frontend|web|client|renderer|app/\(|Views|Pages|Components|Shared)(?:/|$)|"
            r"\.(?:tsx|jsx|vue|svelte|astro|html|razor|cshtml|xaml|css|scss|less|dart|swift|storyboard|xib|"
            r"blade\.php|twig|erb|hbs)$"
        ),
    ),
    (
        "api",
        re.compile(
            r"(?:^|/)(?:api|apis|controllers?|routes?|routers?|handlers?|endpoints?|services?|server|backend|"
            r"graphql|grpc|resolvers?|middlewares?|Controllers|Endpoints|Services|Handlers|cmd|internal)(?:/|$)|"
            r"(?:^|/)(?:Program\.cs|Startup\.cs|main\.go|main\.rs|app\.py|manage\.py|server\.[jt]s|"
            r"\w+Controller\.\w+|\w+Service\.\w+)$"
        ),
    ),
    (
        "docs",
        re.compile(
            r"(?:^|/)(?:docs?|documentation|adr|wiki)(?:/|$)|\.(?:md|rst|adoc)$", re.I
        ),
    ),
)

_MANIFESTS = re.compile(
    r"(?:^|/)(?:package\.json|[^/]+\.csproj|[^/]+\.sln|pyproject\.toml|requirements\.txt|go\.mod|Cargo\.toml|"
    r"pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pubspec\.yaml|composer\.json|Gemfile|"
    r"Package\.swift|mix\.exs|deno\.json)$"
)
_RECORD = Path(".workpilot") / "onboarding" / "tour.json"
_MAX_READ_FILES = 2000
_MAX_READ_CHARS = 100_000


def area_of(path: str) -> str:
    """The area of the project ``path`` belongs to, the same way on every stack."""
    normal = path.replace("\\", "/")
    for area, pattern in _AREA_RULES:
        if pattern.search(normal):
            return area
    return "general"


def role_tours(tour: list[TourStep]) -> dict[str, list[int]]:
    """``{role: [step order…]}``: the steps each role sees, in the tour's order."""
    areas = {step.order: area_of(step.file_path) for step in tour}
    tours: dict[str, list[int]] = {"fullstack": [step.order for step in tour]}
    for role, wanted in _ROLE_AREAS.items():
        focused = [s.order for s in tour if areas[s.order] in wanted]
        general = [
            s.order
            for s in tour
            if areas[s.order] in {"general", "docs"}
            or s.category in {"entrypoint", "doc", "command"}
        ]
        keep = set(focused) | set(general)
        tours[role] = (
            [s.order for s in tour if s.order in keep]
            if focused
            else tours["fullstack"]
        )
    return tours


@dataclass
class Chapter:
    id: str
    """``structure``, ``entry``, ``critical``, ``fragile`` or ``decisions``."""
    title: Text
    lines: list[Text] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)
    """What the chapter says, as data, for the narrator."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title.to_dict(),
            "lines": [line.to_dict() for line in self.lines],
            "files": list(self.files),
        }


@dataclass
class Story:
    chapters: list[Chapter] = field(default_factory=list)
    hotspots: list[Hotspot] = field(default_factory=list)
    decisions: list[Decision] = field(default_factory=list)
    roles: dict[str, list[int]] = field(default_factory=dict)
    areas: dict[str, str] = field(default_factory=dict)
    """Area of each hot spot and tour file, for the page's role filter."""
    stacks: dict[str, list[str]] = field(default_factory=dict)
    fingerprint: str = ""
    modules: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "chapters": [c.to_dict() for c in self.chapters],
            "hotspots": [h.to_dict() for h in self.hotspots],
            "decisions": [d.to_dict() for d in self.decisions],
            "roles": self.roles,
            "areas": self.areas,
            "stacks": self.stacks,
            "fingerprint": self.fingerprint,
            "modules": self.modules,
        }


def _stacks(architecture: list[Any]) -> dict[str, list[str]]:
    """The directories of each language, when the project has more than one."""
    by_language: dict[str, list[str]] = {}
    for node in architecture:
        languages = list(getattr(node, "languages", []) or [])
        if languages:
            by_language.setdefault(languages[0], []).append(node.path)
    return by_language if len(by_language) > 1 else {}


def build_chapters(
    guide: Any, hotspots: list[Hotspot], decisions: list[Decision]
) -> tuple[list[Chapter], dict[str, list[str]]]:
    """The five chapters, each with the facts it is built on."""
    chapters: list[Chapter] = []
    stacks = _stacks(guide.architecture)
    structure = Chapter("structure", text("story.chapter.structure"))
    if stacks:
        for language, paths in sorted(stacks.items()):
            structure.lines.append(
                text(
                    "story.line.stack",
                    language=language,
                    paths=", ".join(f"{p}/" for p in paths[:6]),
                )
            )
    for node in guide.architecture[:8]:
        structure.lines.append(
            text(
                "step.line.architecture",
                path=node.path,
                role=node.role_i18n or raw(node.role),
                count=node.file_count,
            )
        )
        structure.files.append(node.path)
    structure.facts = {
        "techStack": list(guide.tech_stack)[:10],
        "modules": [
            {"path": n.path, "role": n.role, "files": n.file_count}
            for n in guide.architecture[:12]
        ],
        "stacks": stacks,
    }
    chapters.append(structure)

    if guide.entry_points:
        entry = Chapter("entry", text("story.chapter.entry"))
        for kf in guide.entry_points[:5]:
            entry.lines.append(
                text(
                    "step.line.keyFile",
                    path=kf.path,
                    reason=kf.reason_i18n or raw(kf.reason),
                )
            )
            entry.files.append(kf.path)
        entry.facts = {
            "entryPoints": [
                {"path": k.path, "reason": k.reason} for k in guide.entry_points[:5]
            ]
        }
        chapters.append(entry)

    if hotspots:
        top = max(hotspots, key=lambda h: (h.churn, h.risk))
        critical = Chapter("critical", text("story.chapter.critical"), files=[top.path])
        critical.lines.append(
            text(
                "story.line.critical",
                path=top.path,
                churn=top.churn,
                authors=top.authors,
                complexity=top.complexity,
            )
        )
        critical.facts = {
            "file": top.to_dict() | {"reasons": [r.fallback for r in top.reasons]}
        }
        chapters.append(critical)

    fragile_spots = [h for h in hotspots if h.danger or not h.tested][:6]
    if fragile_spots:
        fragile = Chapter("fragile", text("story.chapter.fragile"))
        for spot in fragile_spots:
            zones = ", ".join(text(f"story.danger.{k}").fallback for k in spot.danger)
            if spot.danger:
                fragile.lines.append(
                    text(
                        "story.line.danger",
                        path=spot.path,
                        zones=_joined([text(f"story.danger.{k}") for k in spot.danger]),
                        risk=spot.risk,
                    )
                )
            else:
                fragile.lines.append(
                    text("story.line.untested", path=spot.path, risk=spot.risk)
                )
            fragile.files.append(spot.path)
            fragile.facts.setdefault("files", []).append(
                {
                    "path": spot.path,
                    "zones": zones,
                    "tested": spot.tested,
                    "risk": spot.risk,
                }
            )
        chapters.append(fragile)

    team = Chapter("decisions", text("story.chapter.decisions"))
    for decision in decisions:
        if decision.source == "memory":
            kind = (
                text(f"story.memory.{decision.status}")
                if decision.status in {"gotcha", "pattern"}
                else raw(decision.status)
            )
            team.lines.append(
                text("story.line.memory", kind=kind, title=decision.title)
            )
        elif decision.source == "commit":
            team.lines.append(
                text(
                    "story.line.breaking",
                    ref=decision.ref,
                    date=decision.date or "—",
                    title=decision.title,
                )
            )
        else:
            team.lines.append(
                text(
                    "story.line.adr",
                    title=decision.title,
                    status=decision.status or "—",
                    date=decision.date or "—",
                    path=decision.path,
                )
            )
        if decision.path:
            team.files.append(decision.path)
    if not decisions:
        team.lines.append(text("story.line.noDecision"))
    team.facts = {"decisions": [d.to_dict() for d in decisions]}
    chapters.append(team)
    return chapters, stacks


def _joined(items: list[Text]) -> Text:
    """A list of translated words as one parameter (``security, billing``)."""
    if len(items) == 1:
        return items[0]
    return text("story.list", first=items[0], rest=_joined(items[1:]))


def build_story(root: Path, scan: Any, guide: Any, tour: list[TourStep]) -> Story:
    """The story of the project ``scan`` walked: hot spots, decisions, chapters, roles."""
    code_files = scan.code_files

    def read(path: str) -> str:
        return scan.read(path, max_chars=_MAX_READ_CHARS)

    hotspots = analyse_hotspots(root, code_files[:_MAX_READ_FILES], read)
    decisions = read_decisions(root, scan.files, read)
    chapters, stacks = build_chapters(guide, hotspots, decisions)
    digest, modules, _ = fingerprint(scan.files, code_files)
    areas = {step.file_path: area_of(step.file_path) for step in tour}
    areas.update({spot.path: area_of(spot.path) for spot in hotspots})
    return Story(
        chapters=chapters,
        hotspots=hotspots,
        decisions=decisions,
        roles=role_tours(tour),
        areas=areas,
        stacks=stacks,
        fingerprint=digest,
        modules=modules,
    )


# -- quiz ---------------------------------------------------------------------


def story_quiz(hotspots: list[Hotspot], code_files: list[str]) -> list[QuizQuestion]:
    """Two questions from the hot spots: the busiest file, and where the danger zone is."""
    questions: list[QuizQuestion] = []
    churned = sorted((h for h in hotspots if h.churn), key=lambda h: -h.churn)
    if len(churned) >= 1:
        top = churned[0]
        others = [
            raw(f)
            for f in sorted(code_files)
            if f != top.path
            and not any(h.path == f and h.churn >= top.churn for h in hotspots)
        ]
        q = _make_question(
            text("story.quiz.churn.question"),
            raw(top.path),
            [raw(h.path) for h in churned[1:4]],
            rationale=text(
                "story.quiz.churn.rationale", path=top.path, count=top.churn
            ),
            category="files",
            difficulty="medium",
            fillers=others[:6],
        )
        if q:
            questions.append(q)
    for kind in ("migrations", "security", "billing"):
        zone = [h for h in hotspots if kind in h.danger]
        if not zone:
            continue
        safe = [raw(h.path) for h in hotspots if not h.danger][:3]
        fillers = [
            raw(f) for f in sorted(code_files) if f not in {h.path for h in zone}
        ][:6]
        q = _make_question(
            text(f"story.quiz.zone.{kind}"),
            raw(zone[0].path),
            safe,
            rationale=text("story.quiz.zone.rationale", path=zone[0].path),
            category="architecture",
            difficulty="medium",
            fillers=fillers,
        )
        if q:
            questions.append(q)
            break
    return questions


# -- freshness ----------------------------------------------------------------


def _modules(files: list[str], code_files: set[str]) -> list[str]:
    """Folders (two levels deep at most) holding at least three code files."""
    counts: Counter[str] = Counter()
    for file in files:
        if file not in code_files:
            continue
        parts = PurePosixPath(file).parts[:-1]
        for depth in (1, 2):
            if len(parts) >= depth:
                counts["/".join(parts[:depth])] += 1
    return sorted(m for m, n in counts.items() if n >= 3)


def fingerprint(
    files: list[str], code_files: list[str]
) -> tuple[str, list[str], list[str]]:
    """``(digest, modules, manifests)`` of the project's shape."""
    modules = _modules(files, set(code_files))
    manifests = sorted(f for f in files if _MANIFESTS.search(f))
    digest = hashlib.sha256(json.dumps([modules, manifests]).encode()).hexdigest()[:16]
    return digest, modules, manifests


def _record_path(root: Path) -> Path | None:
    folder = root
    for part in _RECORD.parts[:-1]:
        folder = folder / part
        if folder.is_symlink():
            return None  # never follow a link out of the project
    return root / _RECORD


def save_fingerprint(
    root: Path, digest: str, modules: list[str], manifests: list[str]
) -> None:
    """Keep the shape the tour was made for; silent when it cannot be written."""
    path = _record_path(root)
    if path is None or path.is_symlink():
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "fingerprint": digest,
            "modules": modules,
            "manifests": manifests,
            "generatedAt": datetime.now(tz=UTC).isoformat(),
        }
        path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    except OSError as exc:
        logger.info("Tour record not written: %s", type(exc).__name__)


def freshness(root: Path, files: list[str], code_files: list[str]) -> dict[str, Any]:
    """Whether the last tour still fits the project, and what changed since."""
    digest, modules, manifests = fingerprint(files, code_files)
    path = _record_path(root)
    try:
        saved = (
            json.loads(path.read_text(encoding="utf-8"))
            if path and path.is_file() and not path.is_symlink()
            else None
        )
    except (OSError, ValueError):
        saved = None
    if not isinstance(saved, dict) or not isinstance(saved.get("modules"), list):
        return {
            "known": False,
            "stale": False,
            "added": [],
            "removed": [],
            "generatedAt": "",
        }
    before = {str(m) for m in saved.get("modules", [])} | {
        str(m) for m in saved.get("manifests", []) or []
    }
    now = set(modules) | set(manifests)
    added, removed = sorted(now - before), sorted(before - now)
    return {
        "known": True,
        "stale": saved.get("fingerprint") != digest and bool(added or removed),
        "added": added[:20],
        "removed": removed[:20],
        "generatedAt": str(saved.get("generatedAt") or ""),
    }
