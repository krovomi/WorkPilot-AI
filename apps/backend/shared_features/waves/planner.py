"""Execution waves across cards. Pure and deterministic: no I/O, no clock, no
model. The same algorithm as the desktop (``main/conflict-waves/planner.ts``):

1. A card's footprint is the files its plan declares ∪ the files its build
   workspace changed; fragile zones and code links add to a pair's score.
2. Conflict graph: an edge when the score is above the tolerance, when a test
   merge conflicted, or when one side has no known footprint (``isolate``).
3. ``blockedBy`` are precedence constraints; a cycle (Tarjan) is excluded,
   with the cards waiting on it.
4. Greedy colouring by dependency depth, planned first, weighted conflict
   degree, priority, age, id: each card goes in the feasible wave that adds
   the least residual risk, the earliest on a tie.
5. Inside a wave, the card that shares most with later waves merges first.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .code_links import MAX_CODE_WEIGHT, SpecCode, code_links
from .scorer import (
    MAX_FRAGILE_WEIGHT,
    CoChangeIndex,
    Footprint,
    build_footprint,
    display_sort,
    fragile_links,
    risk_level,
    score_pair,
)

MAX_LISTED_FILES = 20


@dataclass
class PlannerTask:
    id: str
    title: str
    status: str
    #: 0 when unset, 4 for urgent.
    priority_weight: int = 0
    created_at_ms: int = 0
    blocked_by: list[str] = field(default_factory=list)
    planned_files: list[str] = field(default_factory=list)
    #: Files the build workspace changed, or None when it has none.
    actual_files: list[str] | None = None
    code: SpecCode | None = None


@dataclass(frozen=True)
class MergeOutcome:
    verdict: str  # "clean" | "conflict"
    files: tuple[str, ...] = ()


@dataclass
class PlannerOptions:
    max_parallel: int
    tolerance: float
    unplanned_policy: str  # "isolate" | "independent"
    drift_threshold: float
    merge_checks: dict[str, MergeOutcome] = field(default_factory=dict)
    co_changes: CoChangeIndex | None = None


@dataclass
class _Node:
    task: PlannerTask
    footprint: Footprint
    planned: bool


def _node(task: PlannerTask) -> _Node:
    footprint = build_footprint(task.planned_files, task.actual_files or [])
    return _Node(task, footprint, bool(footprint))


def pair_key(a: str, b: str) -> str:
    """The same key for (a, b) and (b, a)."""
    return f"{a}\0{b}" if a < b else f"{b}\0{a}"


def _base_key(task: PlannerTask) -> tuple[int, int, str]:
    return (-task.priority_weight, task.created_at_ms, task.id)


def _find_cycles(ids: list[str], edges: dict[str, list[str]]) -> list[list[str]]:
    """Tarjan's strongly connected components of size > 1, iteratively."""
    counter = 0
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    cycles: list[list[str]] = []

    for root in ids:
        if root in index:
            continue
        work: list[tuple[str, int]] = [(root, 0)]
        while work:
            v, i = work.pop()
            if i == 0:
                index[v] = low[v] = counter
                counter += 1
                stack.append(v)
                on_stack.add(v)
            successors = edges[v]
            if i < len(successors):
                work.append((v, i + 1))
                w = successors[i]
                if w not in index:
                    work.append((w, 0))
                elif w in on_stack:
                    low[v] = min(low[v], index[w])
                continue
            if low[v] == index[v]:
                component: list[str] = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    component.append(w)
                    if w == v:
                        break
                if len(component) > 1:
                    cycles.append(sorted(component))
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[v])
    return sorted(cycles, key=lambda c: c[0])


def _drift(node: _Node, threshold: float) -> dict[str, Any] | None:
    task = node.task
    if task.actual_files is None or not task.planned_files:
        return None
    planned = build_footprint(task.planned_files)
    actual = build_footprint(task.actual_files)
    extra = display_sort(d for n, d in actual.items() if n not in planned)
    if not extra or len(extra) < threshold:
        return None
    return {
        "taskId": task.id,
        "extraCount": len(extra),
        "extraFiles": extra[:MAX_LISTED_FILES],
    }


def plan_execution_waves(
    candidates: list[PlannerTask],
    running: list[PlannerTask],
    options: PlannerOptions,
) -> dict[str, Any]:
    max_parallel = max(1, int(options.max_parallel))
    tolerance = max(0.0, options.tolerance)
    isolate = options.unplanned_policy == "isolate"

    def pair_score(a: _Node, b: _Node) -> tuple[int, list[str], list[str], tuple]:
        score, shared = score_pair(a.footprint, b.footprint)
        links = (
            fragile_links(a.footprint, b.footprint, options.co_changes)
            if options.co_changes is not None
            else []
        )
        code = code_links(a.footprint, a.task.code, b.footprint, b.task.code)
        total = (
            score
            + min(len(links), MAX_FRAGILE_WEIGHT)
            + min(len(code[0]) + len(code[1]), MAX_CODE_WEIGHT)
        )
        return total, shared, links, code

    ordered = sorted(candidates, key=_base_key)
    nodes = {t.id: _node(t) for t in ordered}
    ids = [t.id for t in ordered]

    pairs: list[dict[str, Any]] = []
    scores: dict[str, int] = {}
    blocking: set[str] = set()
    degree = dict.fromkeys(ids, 0)
    for i, first in enumerate(ids):
        for second in ids[i + 1 :]:
            a, b = nodes[first], nodes[second]
            unknown = not a.planned or not b.planned
            score, shared, links, (imports, symbols) = pair_score(a, b)
            key = pair_key(first, second)
            merge = options.merge_checks.get(key)
            conflicted = merge is not None and merge.verdict == "conflict"
            is_blocking = isolate if unknown else (score > tolerance or conflicted)
            scores[key] = score
            if is_blocking:
                blocking.add(key)
            if score > 0 or (unknown and isolate) or conflicted:
                pair: dict[str, Any] = {
                    "a": first,
                    "b": second,
                    "score": score,
                    "level": risk_level(score),
                    "sharedFiles": shared[:MAX_LISTED_FILES],
                    "unknown": unknown,
                    "blocking": is_blocking,
                }
                if merge is not None:
                    pair["mergeCheck"] = merge.verdict
                    pair["conflictFiles"] = list(merge.files[:MAX_LISTED_FILES])
                if links:
                    pair["fragileLinks"] = links[:MAX_LISTED_FILES]
                if imports:
                    pair["importLinks"] = imports[:MAX_LISTED_FILES]
                if symbols:
                    pair["symbolLinks"] = symbols[:MAX_LISTED_FILES]
                pairs.append(pair)
                # An unknown pair weighs one: enough to order, not to dominate.
                weight = score if score > 0 else 1
                degree[first] += weight
                degree[second] += weight
    pairs.sort(key=lambda p: (-p["score"], pair_key(p["a"], p["b"])))

    blockers = {
        node_id: sorted(
            {b for b in nodes[node_id].task.blocked_by if b != node_id and b in nodes}
        )
        for node_id in ids
    }

    def score_of(x: str, y: str) -> int:
        return scores[pair_key(x, y)]

    cycles = _find_cycles(ids, blockers)
    excluded: list[dict[str, str]] = []
    out: set[str] = set()
    for cycle in cycles:
        for node_id in cycle:
            out.add(node_id)
            excluded.append({"taskId": node_id, "reason": "cycle"})
    grew = True
    while grew:
        grew = False
        for node_id in ids:
            if node_id not in out and any(b in out for b in blockers[node_id]):
                out.add(node_id)
                excluded.append({"taskId": node_id, "reason": "blocked_by_cycle"})
                grew = True
    excluded.sort(key=lambda e: e["taskId"])
    plannable = [node_id for node_id in ids if node_id not in out]
    total_risk = sum(
        score_of(x, y) for i, x in enumerate(plannable) for y in plannable[i + 1 :]
    )

    depth: dict[str, int] = {}

    def depth_of(node_id: str) -> int:
        # Acyclic once cycles are out; walked without recursion.
        pending = [node_id]
        while pending:
            current = pending[-1]
            missing = [b for b in blockers[current] if b not in depth]
            if missing:
                pending.extend(missing)
                continue
            pending.pop()
            depth[current] = max((depth[b] for b in blockers[current]), default=-1) + 1
        return depth[node_id]

    for node_id in plannable:
        depth_of(node_id)

    colouring = sorted(
        plannable,
        key=lambda n: (
            depth[n],
            not nodes[n].planned,
            -degree[n],
            _base_key(nodes[n].task),
        ),
    )
    members: list[list[str]] = []
    wave_of: dict[str, int] = {}
    for node_id in colouring:
        earliest = max((wave_of[b] for b in blockers[node_id]), default=-1) + 1
        best = len(members)
        best_added = 0
        for w in range(earliest, len(members)):
            wave = members[w]
            if len(wave) >= max_parallel:
                continue
            if any(pair_key(node_id, m) in blocking for m in wave):
                continue
            added = sum(score_of(node_id, m) for m in wave)
            if best == len(members) or added < best_added:
                best, best_added = w, added
        if best == len(members):
            members.append([])
        members[best].append(node_id)
        wave_of[node_id] = best

    def later_share(node_id: str, w: int) -> int:
        return sum(score_of(node_id, m) for later in members[w + 1 :] for m in later)

    residual_risk = 0
    waves: list[dict[str, Any]] = []
    for w, wave in enumerate(members):
        merge_order = sorted(
            wave, key=lambda n: (-later_share(n, w), _base_key(nodes[n].task))
        )
        residual = sum(
            score_of(x, y)
            for i, x in enumerate(merge_order)
            for y in merge_order[i + 1 :]
        )
        residual_risk += residual
        waves.append({"index": w + 1, "taskIds": merge_order, "residualRisk": residual})

    running_nodes = [_node(t) for t in sorted(running, key=_base_key)]
    running_conflicts = []
    for node_id in plannable:
        for other in running_nodes:
            score = pair_score(nodes[node_id], other)[0]
            if score > tolerance:
                running_conflicts.append(
                    {"taskId": node_id, "runningTaskId": other.task.id, "score": score}
                )
    running_conflicts.sort(key=lambda c: (-c["score"], c["taskId"]))

    everyone = [*nodes.values(), *running_nodes]
    drift = [d for d in (_drift(n, options.drift_threshold) for n in everyone) if d]
    tasks = [
        {
            "taskId": n.task.id,
            "title": n.task.title,
            "status": n.task.status,
            "fileCount": len(n.footprint),
            "planned": n.planned,
        }
        for n in everyone
    ]
    return {
        "waves": waves,
        "order": [node_id for wave in waves for node_id in wave["taskIds"]],
        "tasks": tasks,
        "pairs": pairs,
        "cycles": cycles,
        "excluded": excluded,
        "drift": drift,
        "runningConflicts": running_conflicts,
        "totalRisk": total_risk,
        "residualRisk": residual_risk,
    }
