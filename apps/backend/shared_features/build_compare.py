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
  on it, when the ledger names them;
- **mutation score** and **first-run CI**, when its QA and the follow-through
  of its PR recorded them (``build_compare_quality``): the two figures for
  which more is better.

A project's figure for a window is the median over the specs that started in
it: the last thirty days, and the thirty before for the trend, and each of
the last eight weeks for its sparkline. Projects are grouped by segment,
their main language and a size bucket of tracked files, so a side project is
not set against a monorepo, and by the size of their team
(``build_compare_segments``). A group's median is given only when it holds
``min_group`` projects or more, and each of its figures only when that many
of them have it; below that only its size is, so a median never stands for
one identifiable project. Its top tenth (the figure the best
tenth of its projects reach) needs ``min_top`` projects with that figure.
Specs are also compared kind by kind (bug fix, feature, refactoring…), as
their card recorded it, against the same kind in the other projects. Each
group also gives its trend, from the window before to the last, so the
project's own trend can be read against it; a project whose segment changed
during the last window is set against its old and new peers alike.
"""

from __future__ import annotations

import statistics
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from foundation.git_executable import run_git
from shared_features import build_compare_quality as quality
from shared_features import build_compare_segments as segments
from shared_features import usage_ledger

WINDOW = timedelta(days=30)
#: The weeks of a project's own sparkline, the oldest first.
WEEKS = 8
METRICS = (
    "minutes",
    "cost",
    "qa_iterations",
    "agents",
    "mutation_score",
    "ci_first_pass",
)
#: Spec plans read per project, the most read of one and of all, in bytes.
MAX_PLANS = 500
PLAN_LIMIT = 2_000_000
PLANS_TOTAL = 32_000_000
#: A card's metadata read per spec, the most read of one and of all, in bytes.
METADATA_FILE = "task_metadata.json"
METADATA_LIMIT = 200_000
METADATA_TOTAL = 8_000_000
#: A spec's mutation record (it lists every mutant) and follow-through state,
#: the most read of one and of all, in bytes.
RECORD_LIMIT = 2_000_000
RECORDS_TOTAL = 16_000_000
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
    mutation_score: int | None = None
    ci_first_pass: bool | None = None


@dataclass(frozen=True, slots=True)
class ProjectFacts:
    """A project's segment and its specs."""

    stack: str
    size: str
    specs: tuple[SpecFacts, ...]
    team: str = "unknown"
    #: The size and team one window ago, read for the compared project only.
    size_before: str | None = None
    team_before: str | None = None


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


def mutation_scores(project_dir: Path) -> dict[str, int]:
    """Each spec's mutation score, from its last mutation gate."""
    records = _spec_files(
        project_dir, quality.MUTATION_FILE, RECORD_LIMIT, RECORDS_TOTAL
    )
    return quality.by_spec(records, quality.mutation_score)


def first_ci_results(project_dir: Path) -> dict[str, bool]:
    """Whether the CI passed on each spec's PR as it was opened."""
    records = _spec_files(
        project_dir, quality.FOLLOWUP_FILE, METADATA_LIMIT, METADATA_TOTAL
    )
    return quality.by_spec(records, quality.first_ci)


def spec_facts(
    usages: Iterable[usage_ledger.Usage],
    qa: dict[str, int],
    kinds: dict[str, str] | None = None,
    mutation: dict[str, int] | None = None,
    ci: dict[str, bool] | None = None,
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
                mutation_score=(mutation or {}).get(spec_id),
                ci_first_pass=(ci or {}).get(spec_id),
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
    return _size_name(result.stdout.count("\0"))


def _size_name(files: int) -> str:
    for limit, name in SIZE_BUCKETS:
        if files < limit:
            return name
    return "monorepo"


def with_history(facts: ProjectFacts, project_dir: Path, now: datetime) -> ProjectFacts:
    """`facts` with the size and team the project had one window ago."""
    files = segments.tracked_files_at(project_dir, now - WINDOW)
    return replace(
        facts,
        size_before="unknown" if files is None else _size_name(files),
        team_before=segments.team_bucket(project_dir, days_ago=WINDOW.days),
    )


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
            ledgers.usages,
            qa_iterations(project_dir),
            spec_kinds(project_dir),
            mutation_scores(project_dir),
            first_ci_results(project_dir),
        ),
        team=segments.team_bucket(project_dir),
    )


def _median(values: Iterable[float | int | None]) -> float | None:
    present = [v for v in values if v is not None]
    return float(statistics.median(present)) if present else None


def _group_median(values: Iterable[float | int | None], min_group: int) -> float | None:
    """A group's median of one figure, from `min_group` projects that have it."""
    present = [v for v in values if v is not None]
    return _median(present) if len(present) >= min_group else None


def _top(
    values: Iterable[float | None], min_top: int | None, higher: bool = False
) -> float | None:
    """The figure the best tenth reach (the first decile, or the last when
    `higher` is better), from `min_top` values up; None below, or when no
    `min_top` is set."""
    present = sorted(v for v in values if v is not None)
    if min_top is None or len(present) < max(min_top, 2):
        return None
    deciles = statistics.quantiles(present, n=10, method="inclusive")
    return float(deciles[-1] if higher else deciles[0])


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
        "mutation_score": _median(s.mutation_score for s in inside),
        "ci_first_pass": quality.pass_rate(s.ci_first_pass for s in inside),
    }


def _trend(recent: float | None, previous: float | None) -> float | None:
    """The change from the previous window to the last, in percent."""
    if recent is None or previous is None or previous == 0:
        return None
    return (recent - previous) / previous * 100


def _medians(members: list[dict[str, Any]], min_group: int) -> dict[str, Any]:
    return {m: _group_median((p[m] for p in members), min_group) for m in METRICS}


def _group(
    members: list[dict[str, Any]],
    min_group: int,
    min_top: int | None = None,
    before: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """A group's size, medians and top tenth; its trend too when the
    figures of its projects in the window `before` are given."""
    if len(members) < min_group:
        empty = {"projects": len(members), "medians": None, "top": None}
        return empty if before is None else {**empty, "trend": None}
    medians = _medians(members, min_group)
    top = {
        m: _top((p[m] for p in members), min_top, m in quality.HIGHER_IS_BETTER)
        for m in METRICS
    }
    group = {
        "projects": len(members),
        "medians": medians,
        "top": top if any(v is not None for v in top.values()) else None,
    }
    if before is None:
        return group
    previous = _medians(before, min_group) if len(before) >= min_group else {}
    trend = {m: _trend(medians[m], previous.get(m)) for m in METRICS}
    return {
        **group,
        "trend": trend if any(v is not None for v in trend.values()) else None,
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
    sizes, size_from = segments.moved(current.size, current.size_before)
    teams, team_from = segments.moved(current.team, current.team_before)
    tests: dict[str, Callable[[ProjectFacts], bool]] = {
        "segment": lambda p: p.stack == current.stack and p.size in sizes,
        "stack": lambda p: p.stack == current.stack,
        "team": lambda p: p.team in teams,
        "all": lambda _p: True,
    }

    def members(start: datetime, end: datetime, test) -> list[dict[str, Any]]:
        figures = [window(peer, start, end) for peer in peers if test(peer)]
        return [f for f in figures if f["specs"]]

    week = timedelta(days=7)
    return {
        "window_days": WINDOW.days,
        "min_group": min_group,
        "min_top": min_top,
        "segment": {
            "stack": current.stack,
            "size": current.size,
            "team": current.team,
            "size_from": size_from,
            "team_from": team_from,
        },
        "recent": recent,
        "previous": previous,
        "trend": {m: _trend(recent[m], previous[m]) for m in METRICS},
        "weeks": [
            window(current, now - (i + 1) * week, now - i * week)
            for i in reversed(range(WEEKS))
        ],
        "groups": {
            name: _group(
                members(now - WINDOW, now, test),
                min_group,
                min_top,
                members(now - 2 * WINDOW, now - WINDOW, test),
            )
            for name, test in tests.items()
        },
        "kinds": _kinds(
            current,
            [p for p in peers if window(p, now - WINDOW, now)["specs"]],
            now - WINDOW,
            now,
            min_group,
        ),
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
    """`compare` over project folders, each read with `read`, the compared
    one with its segment of one window ago."""
    return compare(
        with_history(read(current), current, now),
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
