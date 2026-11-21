"""How a project compares: its specs against its own past and against other
projects, on numbers that mean the same on every stack and every provider.

Build Analytics shows a project's own figures. This module answers "is that
fast, cheap, clean?" without any central service: on the desktop the other
projects are the person's own, registered in the app; in server mode they are
the projects of the organization the person may read. Nothing is sent
anywhere — every figure is read from the ledgers the agents already keep in
each project (``shared_features.usage_ledger``) and from the spec plans.

Per spec (a ``spec_id`` with at least one recorded agent session):

- **minutes**: from its first to its last agent session, the active time of
  the build, whatever the model or the machine;
- **cost**: what its sessions cost, in USD, as the cost catalog priced them;
- **QA iterations**: the QA sessions its plan's sign-off counts
  (``qa_signoff.qa_session``), when it has one;
- **agents**: the distinct agents (planner, coder, QA reviewer…) that worked
  on it, when the ledger names them.

A project's figure for a window is the median over the specs that started in
it: the last thirty days, and the thirty before for the trend, and each of
the last eight weeks for its sparkline. Projects are grouped by segment,
their main language and a size bucket of tracked files, so a side project is
not set against a monorepo, and by the size of their team
(``build_compare_segments``). A group's median is given only when it holds
``min_group`` projects or more; below that only its size is, so a median
never stands for one identifiable project. Its top tenth (the figure the best
tenth of its projects reach) needs ``min_top`` projects with that figure.
Specs are also compared kind by kind (bug fix, feature, refactoring…), as
their card recorded it, against the same kind in the other projects.
"""

from __future__ import annotations

import statistics
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from foundation.git_executable import run_git
from shared_features import build_compare_segments as segments
from shared_features import usage_ledger

WINDOW = timedelta(days=30)
#: The weeks of a project's own sparkline, the oldest first.
WEEKS = 8
METRICS = ("minutes", "cost", "qa_iterations", "agents")
#: Spec plans read per project, the most read of one and of all, in bytes.
MAX_PLANS = 500
PLAN_LIMIT = 2_000_000
PLANS_TOTAL = 32_000_000
#: A card's metadata read per spec, the most read of one and of all, in bytes.
METADATA_FILE = "task_metadata.json"
METADATA_LIMIT = 200_000
METADATA_TOTAL = 8_000_000
#: Tracked files counted, and the seconds `git ls-files` may take.
GIT_TIMEOUT = 20
#: Upper bounds of the size buckets, in tracked files.
SIZE_BUCKETS = ((500, "small"), (5_000, "medium"), (50_000, "large"))
#: The most QA sessions a plan is believed to hold.
MAX_QA_SESSIONS = 1_000


@dataclass(frozen=True, slots=True)
class SpecFacts:
    """What one spec's agent sessions and plan say."""

    spec_id: str
    started: datetime
    minutes: float
    cost: float
    qa_iterations: int | None
    agents: int | None
    kind: str | None = None


@dataclass(frozen=True, slots=True)
class ProjectFacts:
    """A project's segment and its specs."""

    stack: str
    size: str
    specs: tuple[SpecFacts, ...]
    team: str = "unknown"


def _qa_session(plan: object) -> int | None:
    if not isinstance(plan, dict):
        return None
    signoff = plan.get("qa_signoff")
    if not isinstance(signoff, dict):
        return None
    value = signoff.get("qa_session")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 < value <= MAX_QA_SESSIONS else None


def _spec_files(
    project_dir: Path, filename: str, limit: int, total: int
) -> Iterator[tuple[str, Any]]:
    """Each spec's `filename`, at the project's root then in each build
    workspace: `MAX_PLANS` files and `total` bytes at most, `limit` each."""
    from board_mcp.server import CARD_ID

    root = project_dir.resolve()
    read = 0
    budget = total
    for workpilot in usage_ledger.workspace_dirs(project_dir):
        specs = workpilot / "specs"
        try:
            names = sorted(e.name for e in specs.iterdir() if CARD_ID.match(e.name))
        except OSError:
            continue
        for name in names:
            if read >= MAX_PLANS or budget <= 0:
                return
            read += 1
            value, size = usage_ledger.read_json(
                specs / name / filename, root, min(limit, budget)
            )
            budget -= size
            yield name, value


def qa_iterations(project_dir: Path) -> dict[str, int]:
    """Each spec's QA sessions, from its plan at the project's root or in its
    build workspace (the higher count wins: the workspace is where QA ran)."""
    found: dict[str, int] = {}
    plans = _spec_files(
        project_dir, "implementation_plan.json", PLAN_LIMIT, PLANS_TOTAL
    )
    for name, plan in plans:
        sessions = _qa_session(plan)
        if sessions is not None:
            found[name] = max(sessions, found.get(name, 0))
    return found


def spec_kinds(project_dir: Path) -> dict[str, str]:
    """Each spec's kind, as its card recorded it; the build workspace's copy,
    read last, wins over the root's."""
    found: dict[str, str] = {}
    files = _spec_files(project_dir, METADATA_FILE, METADATA_LIMIT, METADATA_TOTAL)
    for name, metadata in files:
        kind = segments.spec_kind(metadata)
        if kind is not None:
            found[name] = kind
    return found


def spec_facts(
    usages: Iterable[usage_ledger.Usage],
    qa: dict[str, int],
    kinds: dict[str, str] | None = None,
) -> tuple[SpecFacts, ...]:
    """One line per spec that recorded an agent session."""
    facts = []
    for spec_id, spent in sorted(usage_ledger.by_card(usages).items()):
        agents = {u.agent_type for u in spent if u.agent_type}
        facts.append(
            SpecFacts(
                spec_id=spec_id,
                started=spent[0].at,
                minutes=(spent[-1].at - spent[0].at).total_seconds() / 60,
                cost=sum(u.cost for u in spent),
                qa_iterations=qa.get(spec_id),
                agents=len(agents) or None,
                kind=(kinds or {}).get(spec_id),
            )
        )
    return tuple(facts)


def size_bucket(project_dir: Path) -> str:
    """The project's size, by the files git tracks; "unknown" without git."""
    if not project_dir.is_dir():
        return "unknown"
    result = run_git(["ls-files", "-z"], cwd=project_dir, timeout=GIT_TIMEOUT)
    if result.returncode != 0:
        return "unknown"
    files = result.stdout.count("\0")
    for limit, name in SIZE_BUCKETS:
        if files < limit:
            return name
    return "monorepo"


def main_stack(project_dir: Path) -> str:
    """The project's first detected language, or "other"."""
    from project.stack import detect_languages

    languages = detect_languages(project_dir)
    return languages[0] if languages else "other"


def project_facts(project_dir: Path) -> ProjectFacts:
    """Read a project: its ledgers, its plans and cards, its stack, its size
    and its team."""
    ledgers = usage_ledger.read_ledgers(project_dir)
    return ProjectFacts(
        stack=main_stack(project_dir),
        size=size_bucket(project_dir),
        specs=spec_facts(
            ledgers.usages, qa_iterations(project_dir), spec_kinds(project_dir)
        ),
        team=segments.team_bucket(project_dir),
    )


def _median(values: Iterable[float | int | None]) -> float | None:
    present = [v for v in values if v is not None]
    return float(statistics.median(present)) if present else None


def _top(values: Iterable[float | None], min_top: int | None) -> float | None:
    """The figure the best tenth reach (lower is better), from `min_top`
    values up; None below, or when no `min_top` is set."""
    present = sorted(v for v in values if v is not None)
    if min_top is None or len(present) < max(min_top, 2):
        return None
    return float(statistics.quantiles(present, n=10, method="inclusive")[0])


def window(
    facts: ProjectFacts, start: datetime, end: datetime, kind: str | None = None
) -> dict[str, Any]:
    """The project's medians over the specs started in [start, end), of
    `kind` only when one is given."""
    inside = [
        s
        for s in facts.specs
        if start <= s.started < end and (kind is None or s.kind == kind)
    ]
    return {
        "specs": len(inside),
        "minutes": _median(s.minutes for s in inside),
        "cost": _median(s.cost for s in inside),
        "qa_iterations": _median(s.qa_iterations for s in inside),
        "agents": _median(s.agents for s in inside),
    }


def _trend(recent: float | None, previous: float | None) -> float | None:
    """The change from the previous window to the last, in percent."""
    if recent is None or previous is None or previous == 0:
        return None
    return (recent - previous) / previous * 100


def _group(
    members: list[dict[str, Any]], min_group: int, min_top: int | None = None
) -> dict[str, Any]:
    if len(members) < min_group:
        return {"projects": len(members), "medians": None, "top": None}
    top = {m: _top((p[m] for p in members), min_top) for m in METRICS}
    return {
        "projects": len(members),
        "medians": {m: _median(p[m] for p in members) for m in METRICS},
        "top": top if any(v is not None for v in top.values()) else None,
    }


def _kinds(
    current: ProjectFacts,
    peers: list[ProjectFacts],
    start: datetime,
    end: datetime,
    min_group: int,
) -> list[dict[str, Any]]:
    """The project's figures kind by kind, against the same kind in the
    other projects, the most built kind first."""
    lines = []
    for kind in segments.KINDS:
        own = window(current, start, end, kind)
        if not own["specs"]:
            continue
        others = [window(peer, start, end, kind) for peer in peers]
        lines.append(
            {
                "kind": kind,
                **own,
                "group": _group([f for f in others if f["specs"]], min_group),
            }
        )
    return sorted(lines, key=lambda line: -line["specs"])


def compare(
    current: ProjectFacts,
    peers: list[ProjectFacts],
    now: datetime,
    *,
    min_group: int,
    min_top: int | None = None,
) -> dict[str, Any]:
    """The comparison of `current` with its own past and with `peers`.

    Only peers with a spec in the last window count. `peers_detail` is left
    to the caller: the desktop lists the person's own projects, a server
    never lists another project. A group's top tenth is given from `min_top`
    projects, never without one.
    """
    recent = window(current, now - WINDOW, now)
    previous = window(current, now - 2 * WINDOW, now - WINDOW)
    active = [(peer, window(peer, now - WINDOW, now)) for peer in peers]
    active = [(peer, figures) for peer, figures in active if figures["specs"]]
    same_stack = [f for p, f in active if p.stack == current.stack]
    same_segment = [
        f for p, f in active if p.stack == current.stack and p.size == current.size
    ]
    same_team = [f for p, f in active if p.team == current.team]
    week = timedelta(days=7)
    return {
        "window_days": WINDOW.days,
        "min_group": min_group,
        "min_top": min_top,
        "segment": {
            "stack": current.stack,
            "size": current.size,
            "team": current.team,
        },
        "recent": recent,
        "previous": previous,
        "trend": {m: _trend(recent[m], previous[m]) for m in METRICS},
        "weeks": [
            window(current, now - (i + 1) * week, now - i * week)
            for i in reversed(range(WEEKS))
        ],
        "groups": {
            "segment": _group(same_segment, min_group, min_top),
            "stack": _group(same_stack, min_group, min_top),
            "team": _group(same_team, min_group, min_top),
            "all": _group([f for _p, f in active], min_group, min_top),
        },
        "kinds": _kinds(current, [p for p, _f in active], now - WINDOW, now, min_group),
    }


def compare_paths(
    current: Path,
    peers: Iterable[Path],
    now: datetime,
    *,
    min_group: int,
    min_top: int | None = None,
    read: Callable[[Path], ProjectFacts] = project_facts,
) -> dict[str, Any]:
    """`compare` over project folders, each read with `read`."""
    return compare(
        read(current),
        [read(p) for p in peers],
        now,
        min_group=min_group,
        min_top=min_top,
    )


def peer_line(name: str, facts: ProjectFacts, now: datetime) -> dict[str, Any]:
    """One of the person's own projects, for the desktop's list."""
    return {
        "name": name,
        "stack": facts.stack,
        "size": facts.size,
        "team": facts.team,
        **window(facts, now - WINDOW, now),
    }
