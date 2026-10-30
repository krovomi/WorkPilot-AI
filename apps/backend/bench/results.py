"""The bench table: what each provider × model × effort resolved, measured.

``<project>/.workpilot/bench/results.json`` keeps one record per judged build,
across runs; the table is computed from the records when read. Only judged
builds are records: a build that did not start, or that was interrupted, says
nothing about its model.

Three readers outside the bench:

* Formula Lab takes ``history_samples`` as success samples per
  (provider, model), next to the usage history (``cost_intelligence``);
* the model router takes ``scores`` and skips a model the bench saw resolve
  less than half of at least three cases (``model_router``), on the cards of
  the task's kind when there are enough of them;
* the card's engine step reads ``recommendations``: per kind of card, the
  cheapest engine among those close to the best measured rate.
"""

from __future__ import annotations

from pathlib import Path

from .layout import main_project, now, read_json, results_path, write_json

MAX_RECORDS = 2000
# The router's rule: a model is set aside only on this much evidence.
ROUTER_MIN_CASES = 3
ROUTER_MIN_RATE = 0.5
# The recommendation's rule: an engine is recommended only on the router's
# evidence (three cards, half resolved); among the engines within this margin
# of the best rate, the cheapest measured one wins.
RECOMMEND_MARGIN = 0.1
ALL_KINDS = "*"

_RECORD_KEYS = (
    "runId",
    "buildId",
    "caseId",
    "kind",
    "provider",
    "model",
    "effort",
    "resolved",
    "f2pPassed",
    "f2pTotal",
    "p2pPassed",
    "p2pTotal",
    "costUsd",
    "durationS",
    "judgedAt",
)


def _records(project_dir: Path) -> list[dict]:
    data = read_json(results_path(project_dir)) or {}
    records = data.get("records")
    if not isinstance(records, list):
        return []
    return _records_from([r for r in records if isinstance(r, dict)])


def add_records(project_dir: Path, new: list[dict]) -> None:
    """Append ``new``, replacing records of the same run and build.

    The table is written next to the records, for readers that do not
    compute it (the app's main process).
    """
    keys = {(r["runId"], r["buildId"]) for r in new}
    records = [
        r
        for r in _records(project_dir)
        if (r.get("runId"), r.get("buildId")) not in keys
    ]
    records.extend({key: r.get(key) for key in _RECORD_KEYS} for r in new)
    records = records[-MAX_RECORDS:]
    valid = _records_from(records)
    write_json(
        results_path(project_dir),
        {
            "version": 1,
            "updatedAt": now(),
            "records": records,
            "table": _table(valid),
            "recommendations": _recommendations(valid),
        },
    )


def _records_from(records: list[dict]) -> list[dict]:
    return [
        r
        for r in records
        if isinstance(r.get("provider"), str)
        and isinstance(r.get("model"), str)
        and isinstance(r.get("resolved"), bool)
    ]


def table(project_dir: Path) -> list[dict]:
    """One row per provider × model × effort, best resolution rate first."""
    return _table(_records(project_dir))


def _table(records: list[dict]) -> list[dict]:
    rows: dict[tuple[str, str, str], dict] = {}
    for record in records:
        key = (record["provider"], record["model"], str(record.get("effort") or ""))
        row = rows.setdefault(
            key,
            {
                "provider": key[0],
                "model": key[1],
                "effort": key[2],
                "judged": 0,
                "resolved": 0,
                "cases": set(),
                "runs": set(),
                "f2pPassed": 0,
                "f2pTotal": 0,
                "cost": 0.0,
                "costed": 0,
                "duration": 0.0,
                "timed": 0,
            },
        )
        row["judged"] += 1
        row["resolved"] += 1 if record["resolved"] else 0
        row["cases"].add(record.get("caseId"))
        row["runs"].add(record.get("runId"))
        row["f2pPassed"] += _int(record.get("f2pPassed"))
        row["f2pTotal"] += _int(record.get("f2pTotal"))
        cost = record.get("costUsd")
        if isinstance(cost, (int, float)) and cost >= 0:
            row["cost"] += float(cost)
            row["costed"] += 1
        duration = record.get("durationS")
        if isinstance(duration, (int, float)) and duration >= 0:
            row["duration"] += float(duration)
            row["timed"] += 1
    out = []
    for row in rows.values():
        out.append(
            {
                "provider": row["provider"],
                "model": row["model"],
                "effort": row["effort"],
                "judged": row["judged"],
                "resolved": row["resolved"],
                "rate": row["resolved"] / row["judged"],
                "cases": len(row["cases"]),
                "runs": len(row["runs"]),
                "f2pRate": (row["f2pPassed"] / row["f2pTotal"])
                if row["f2pTotal"]
                else None,
                "avgCostUsd": (row["cost"] / row["costed"]) if row["costed"] else None,
                "avgDurationS": (row["duration"] / row["timed"])
                if row["timed"]
                else None,
            }
        )
    out.sort(key=lambda r: (-r["rate"], -r["judged"], r["provider"], r["model"]))
    return out


def _int(value) -> int:
    return value if isinstance(value, int) and value >= 0 else 0


def history_samples(project_dir: Path) -> list[dict]:
    """Success samples for Formula Lab, one per judged build."""
    return [
        {
            "provider": r["provider"].lower(),
            "model": r["model"],
            "success": r["resolved"],
            "source": "bench",
        }
        for r in _records(main_project(project_dir))
    ]


def recommendations(project_dir: Path) -> dict[str, dict]:
    """``{kind: engine}``, and ``"*"`` over every card; a kind without enough
    evidence has no entry."""
    return _recommendations(_records(main_project(project_dir)))


def _recommendations(records: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    overall = _recommend(records)
    if overall:
        out[ALL_KINDS] = overall
    kinds = sorted({r["kind"] for r in records if isinstance(r.get("kind"), str)})
    for kind in kinds:
        pick = _recommend([r for r in records if r.get("kind") == kind])
        if pick:
            out[kind] = pick
    return out


def _recommend(records: list[dict]) -> dict | None:
    rows = [
        row
        for row in _table(records)
        if row["cases"] >= ROUTER_MIN_CASES and row["rate"] >= ROUTER_MIN_RATE
    ]
    if not rows:
        return None
    best = max(row["rate"] for row in rows)
    close = [row for row in rows if row["rate"] >= best - RECOMMEND_MARGIN - 1e-9]
    # An engine whose cost was never measured cannot win on cost.
    close.sort(
        key=lambda row: (
            row["avgCostUsd"] is None,
            row["avgCostUsd"] or 0.0,
            -row["rate"],
            -row["judged"],
            row["provider"],
            row["model"],
            row["effort"],
        )
    )
    pick = close[0]
    keys = ("provider", "model", "effort", "judged", "resolved", "rate", "cases")
    return {
        **{key: pick[key] for key in keys},
        "avgCostUsd": pick["avgCostUsd"],
        "bestRate": best,
        "considered": len(rows),
    }


def scores(project_dir: Path, kind: str | None = None) -> dict[tuple[str, str], dict]:
    """``{(provider, model): {resolved, judged, cases}}``, every effort together.

    With ``kind``, a model the bench judged on enough cards of that kind is
    scored on those cards only (and its entry says ``kind``); the others keep
    their score over every card.
    """
    records = _records(main_project(project_dir))
    out = _scores(records)
    if kind:
        same = _scores([r for r in records if r.get("kind") == kind])
        for key, entry in same.items():
            if entry["cases"] >= ROUTER_MIN_CASES:
                out[key] = {**entry, "kind": kind}
    return out


def _scores(records: list[dict]) -> dict[tuple[str, str], dict]:
    out: dict[tuple[str, str], dict] = {}
    for r in records:
        entry = out.setdefault(
            (r["provider"].lower(), r["model"]),
            {"resolved": 0, "judged": 0, "cases": set()},
        )
        entry["resolved"] += 1 if r["resolved"] else 0
        entry["judged"] += 1
        entry["cases"].add(r.get("caseId"))
    for entry in out.values():
        entry["cases"] = len(entry["cases"])
    return out


def router_verdict(score: dict) -> bool:
    """Whether the router should pass this model by: at least three distinct
    cards, and less than half of its judged builds resolved."""
    judged = score.get("judged") or 0
    return (
        (score.get("cases") or 0) >= ROUTER_MIN_CASES
        and judged > 0
        and score.get("resolved", 0) / judged < ROUTER_MIN_RATE
    )
