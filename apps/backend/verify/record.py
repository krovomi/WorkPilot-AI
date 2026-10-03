"""What a verification found, on disk, in one shape every reader shares.

`<spec_dir>/verify/verify.json` is read by the hard gate (`app-verified`), the
QA reviewer's prompt (`verify.prompt`), the Kanban card and tab
(`GET /api/verify/`), the post-QA replay, the learning loop and the brain. One
writer, one shape: a second reader that re-derived the verdict from the logs
would eventually disagree with the first.

The agent's own observations — a step of the scenario, a confirmed state, an
endpoint it called, its verdict — arrive through `verify_record`, possibly
from another process (the MCP server on the Claude path). They are appended to
`events.jsonl` beside the record and folded in when the loop finishes, so a
crash halfway loses nothing that was already said.

**The verdict is computed, not declared.** `pass` needs an application that
answered with no error left; any remaining crash, exception, build error, 5xx
or failed endpoint is `fail`; an agent saying "fail" downgrades, an agent
saying "pass" over a measured error does not upgrade. Only errors the
environment caused (a database not running, a port taken) and nothing
launched at all are `unknown` — the code was not shown to be wrong, and not
shown to be right either.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

__all__ = [
    "RECORD_FILE",
    "EVENTS_FILE",
    "new_record",
    "load_record",
    "save_record",
    "append_event",
    "read_events",
    "fold_events",
    "compute_status",
    "render_report",
    "record_path",
    "persist_plan_summary",
    "VERDICT_LINE",
]

RECORD_FILE = "verify.json"
EVENTS_FILE = "events.jsonl"
REPORT_FILE = "report.md"
VERSION = 1

#: Statuses a record can carry.
STATUSES = ("pass", "fail", "unknown", "not-applicable", "disabled", "running")

_BLOCKING_KINDS = {
    "crash",
    "exception",
    "build",
    "http",
    "console",
    "network",
    "launch",
}


def record_path(spec_dir: Path | str) -> Path:
    return Path(spec_dir) / "verify" / RECORD_FILE


def new_record(**fields: Any) -> dict:
    record = {
        "version": VERSION,
        "status": "running",
        "reason": "",
        "started_at": time.time(),
        "finished_at": None,
        "provider": "",
        "model": "",
        "effort": "",
        "head": "",
        "targets": [],
        "rounds": [],
        "scenario": [],
        "confirmations": [],
        "endpoints": [],
        "perf": [],
        "lighthouse": {},
        "latency": {},
        "mobile": [],
        "screenshots": [],
        "agent_verdicts": [],
        "findings": [],
        "browser": {"engine": "", "reasons": []},
        "score": None,
        "learned": {},
    }
    record.update(fields)
    return record


def load_record(base: Path) -> dict | None:
    try:
        data = json.loads((base / RECORD_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save_record(base: Path, record: dict) -> Path:
    base.mkdir(parents=True, exist_ok=True)
    target = base / RECORD_FILE
    partial = target.with_suffix(".json.partial")
    partial.write_text(
        json.dumps(record, indent=2, ensure_ascii=False, default=str), encoding="utf-8"
    )
    os.replace(partial, target)
    try:
        (base / REPORT_FILE).write_text(render_report(record), encoding="utf-8")
    except OSError:
        pass
    return target


def append_event(base: Path, kind: str, payload: dict) -> None:
    base.mkdir(parents=True, exist_ok=True)
    line = json.dumps(
        {"kind": kind, "at": time.time(), **payload}, ensure_ascii=False, default=str
    )
    with open(base / EVENTS_FILE, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def read_events(base: Path) -> list[dict]:
    out = []
    try:
        lines = (base / EVENTS_FILE).read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for line in lines[-500:]:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            out.append(event)
    return out


def fold_events(record: dict, events: list[dict]) -> dict:
    """The agent's observations, into the record they describe."""
    for event in events:
        kind = event.get("kind")
        if kind == "step":
            record["scenario"].append(
                {
                    k: event.get(k)
                    for k in ("action", "target", "url", "uid", "value", "text", "note")
                    if event.get(k) is not None
                }
            )
        elif kind == "confirm":
            record["confirmations"].append(
                {
                    k: event.get(k)
                    for k in ("state", "evidence", "target", "url", "screenshot")
                    if event.get(k) is not None
                }
            )
        elif kind == "endpoint":
            record["endpoints"].append(
                {k: v for k, v in event.items() if k not in ("kind", "at")}
            )
        elif kind == "screenshot":
            record["screenshots"].append(
                {
                    k: event.get(k)
                    for k in ("path", "label", "target", "platform", "url")
                }
            )
        elif kind == "perf":
            record["perf"].append(
                {k: v for k, v in event.items() if k not in ("kind", "at")}
            )
        elif kind == "verdict":
            verdict = str(event.get("verdict") or "").lower()
            if verdict in ("pass", "fail", "unknown"):
                record["agent_verdicts"].append(
                    {
                        "verdict": verdict,
                        "summary": str(event.get("summary") or "")[:2000],
                    }
                )
        elif kind == "fix":
            record.setdefault("agent_fixes", []).append(
                {k: event.get(k) for k in ("file", "summary")}
            )
    return record


def _remaining_errors(record: dict) -> list[dict]:
    errors: list[dict] = []
    for target in record.get("targets") or []:
        errors += target.get("errors") or []
    for platform in record.get("mobile") or []:
        errors += platform.get("errors") or []
    return errors


def compute_status(record: dict) -> tuple[str, str]:
    """``(status, reason)`` from what the record measured."""
    if record.get("status") in ("disabled", "not-applicable"):
        return record["status"], record.get("reason", "")

    errors = _remaining_errors(record)
    blocking = [e for e in errors if e.get("kind") in _BLOCKING_KINDS]
    environment = [e for e in errors if e.get("kind") == "environment"]
    failed_endpoints = [
        e
        for e in record.get("endpoints") or []
        if e.get("outcome", "called") == "called" and e.get("ok") is False
    ]
    failed_platforms = [
        p for p in record.get("mobile") or [] if p.get("status") == "failed"
    ]
    launched = [
        t
        for t in record.get("targets") or []
        if (t.get("launch") or {}).get("status") in ("ready", "reused")
    ]
    not_started = [
        t
        for t in record.get("targets") or []
        if (t.get("launch") or {}).get("status") in ("exited", "timeout")
    ]
    verified_platforms = [
        p for p in record.get("mobile") or [] if p.get("status") == "verified"
    ]
    agent = [v["verdict"] for v in record.get("agent_verdicts") or []]
    regressions = [
        f for f in record.get("findings") or [] if f.get("severity") == "high"
    ]

    if blocking or failed_endpoints or failed_platforms or regressions:
        parts = []
        if blocking:
            parts.append(f"{len(blocking)} error(s) left")
        if failed_endpoints:
            parts.append(f"{len(failed_endpoints)} endpoint(s) failed")
        if failed_platforms:
            parts.append(f"{len(failed_platforms)} platform(s) failed")
        if regressions:
            parts.append(f"{len(regressions)} regression(s)")
        return "fail", ", ".join(parts)
    if not_started and not environment:
        return "fail", f"{len(not_started)} target(s) did not start"
    if agent and agent[-1] == "fail":
        return "fail", "the verifier reported a failure"
    if environment:
        return "unknown", "the environment prevented the check: " + environment[0].get(
            "message", ""
        )[:160]
    if not launched and not verified_platforms:
        if any(
            p.get("status") in ("blocked", "no-device")
            for p in record.get("mobile") or []
        ):
            return "unknown", "no device could run the app on this machine"
        return "unknown", "nothing could be launched"
    return "pass", ""


VERDICT_LINE = {"pass": "Verify: pass", "fail": "Verify: fail"}


def _fmt(value: Any, unit: str = "") -> str:
    if value is None:
        return "not measured"
    if isinstance(value, float):
        value = round(value, 2 if value < 10 else 0)
        value = int(value) if float(value).is_integer() else value
    return f"{value}{unit}"


def render_report(record: dict) -> str:
    """`verify/report.md` — the same facts, for a person or a reviewer."""
    status = record.get("status", "unknown")
    lines = [
        "# Verification",
        "",
        f"**Status:** {status}"
        + (f" — {record['reason']}" if record.get("reason") else ""),
        "",
    ]
    if record.get("score") is not None:
        lines += [f"**Score:** {record['score']}/100", ""]
    for target in record.get("targets") or []:
        launch = target.get("launch") or {}
        lines.append(
            f"## {target.get('name')} ({target.get('kind')}, {target.get('framework') or '?'})"
        )
        lines.append(
            f"- launch: `{launch.get('command', '')}` → {launch.get('status', '?')}"
            + (f" at {launch.get('url')}" if launch.get("url") else "")
        )
        errors = target.get("errors") or []
        lines.append(f"- errors left: {len(errors)}")
        for error in errors[:10]:
            where = (
                f" ({error.get('file')}:{error.get('line')})"
                if error.get("file")
                else ""
            )
            lines.append(f"  - [{error.get('kind')}] {error.get('message')}{where}")
        lines.append("")
    rounds = record.get("rounds") or []
    if rounds:
        lines.append("## Fix rounds")
        for item in rounds:
            lines.append(
                f"- round {item.get('round')}: {item.get('errors_before')} → {item.get('errors_after')} error(s)"
                + (f" — {item.get('note')}" if item.get("note") else "")
            )
        lines.append("")
    if record.get("confirmations"):
        lines.append("## Confirmed state")
        for item in record["confirmations"]:
            lines.append(f"- {item.get('state')} — evidence: {item.get('evidence')}")
        lines.append("")
    if record.get("endpoints"):
        lines += [
            "## Endpoints",
            "",
            "| Call | Expected | Got | Schema | Latency |",
            "|---|---|---|---|---|",
        ]
        for item in record["endpoints"]:
            schema = {True: "ok", False: "✗", None: "—"}[item.get("schema_ok")]
            lines.append(
                f"| {item.get('method')} {item.get('path')} | {item.get('expected') or '2xx'} | "
                f"{item.get('status') or item.get('outcome')} | {schema} | {_fmt(item.get('latency_ms'), ' ms')} |"
            )
        lines.append("")
    for perf in record.get("perf") or []:
        lines += [
            f"## Performance — {perf.get('url')}",
            f"- engine: {perf.get('engine') or '—'}",
            f"- LCP {_fmt(perf.get('lcp_ms'), ' ms')}, CLS {_fmt(perf.get('cls'))}, "
            f"TBT {_fmt(perf.get('tbt_ms'), ' ms')}, FCP {_fmt(perf.get('fcp_ms'), ' ms')}",
            f"- score: {_fmt(perf.get('score'))}"
            + (
                f" (on {', '.join(perf.get('scored_on') or [])})"
                if perf.get("scored_on")
                else ""
            ),
            "",
        ]
    if record.get("lighthouse"):
        lines.append("## Lighthouse")
        lines += [f"- {k}: {v}" for k, v in record["lighthouse"].items()]
        lines.append("")
    if record.get("latency"):
        lat = record["latency"]
        lines += [
            "## API latency",
            f"- p50 {_fmt(lat.get('p50_ms'), ' ms')}, p95 {_fmt(lat.get('p95_ms'), ' ms')} over {lat.get('count')} call(s)",
            "",
        ]
    for platform in record.get("mobile") or []:
        lines.append(f"## {platform.get('platform')} — {platform.get('status')}")
        if platform.get("device"):
            lines.append(f"- device: {platform['device']}")
        if platform.get("startup_ms") is not None:
            lines.append(f"- cold start: {_fmt(platform['startup_ms'], ' ms')}")
        if platform.get("detail"):
            lines.append(f"- {platform['detail']}")
        lines.append("")
    if record.get("screenshots"):
        lines.append("## Screenshots")
        lines += [
            f"- {s.get('label') or ''}: `{s.get('path')}`"
            for s in record["screenshots"]
        ]
        lines.append("")
    if record.get("findings"):
        lines.append("## Findings")
        lines += [
            f"- [{f.get('severity')}] {f.get('message')}" for f in record["findings"]
        ]
        lines.append("")
    lines.append(VERDICT_LINE.get(status, "Verify: unknown"))
    return "\n".join(lines) + "\n"


def persist_plan_summary(spec_dir: Path, record: dict) -> None:
    """``verification: {status, score, at}`` in `implementation_plan.json`.

    The Kanban card reads the plan, not the record: a badge must not cost a
    request per card. Merged into whatever the file holds, never replacing it.
    """
    path = Path(spec_dir) / "implementation_plan.json"
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(plan, dict):
        return
    plan["verification"] = {
        "status": record.get("status"),
        "score": record.get("score"),
        "reason": record.get("reason", "")[:200],
        "at": record.get("finished_at"),
    }
    partial = path.with_suffix(".json.verify-partial")
    try:
        partial.write_text(
            json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(partial, path)
    except OSError:
        pass
