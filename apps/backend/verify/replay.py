"""Replay a verification after QA — without a model.

The verification runs before QA so QA reviews code already seen working, with
the evidence in front of it. QA then changes code. `verify-replay` is the
answer to *did the QA fixes break what was verified?* — and it costs no token:

* nothing changed since the verification (same `HEAD`, clean tree): skipped;
* otherwise the same targets are launched, the same scenario replayed — each
  click aims at the element **described** in the recorded snapshot row
  (`button "Save"`), not at its uid, which does not survive a reload — the
  same endpoint calls made, and the confirmed state looked for on the page.

A replay that fails turns the record to `fail` ("regressed after QA"), so the
`app-verified` gate, the Kanban badge and the brain all read the regression
from the one record.
"""

from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path

from .detect import detect_targets
from .launch import launch
from .record import load_record, persist_plan_summary, save_record
from .settings import load_settings
from .state import stop_all, work_dir

__all__ = ["run_replay", "run_replay_phase"]

_ROW = re.compile(r"uid=(?P<uid>[\w-]+)\s+(?P<desc>.+)$")


def _uid_for(snapshot: str, description: str) -> str:
    """The uid whose row reads like ``description`` in a fresh snapshot."""
    wanted = re.sub(r"\s+", " ", description or "").strip().lower()
    if not wanted:
        return ""
    rows = []
    for line in snapshot.splitlines():
        match = _ROW.search(line.strip())
        if match:
            rows.append(
                (
                    match.group("uid"),
                    re.sub(r"\s+", " ", match.group("desc")).strip().lower(),
                )
            )
    for uid, desc in rows:
        if desc == wanted:
            return uid
    # The row may have gained a value or lost one; the role and name are what identify it.
    head = re.match(r'^(\S+\s+"[^"]*")', wanted)
    if head:
        for uid, desc in rows:
            if desc.startswith(head.group(1)):
                return uid
    return ""


async def _replay_scenario(toolbox, record: dict) -> list[str]:
    problems: list[str] = []
    steps = record.get("scenario") or []
    if not steps:
        return problems
    target = toolbox.target(None, ("web-frontend", "desktop"))
    browser = await toolbox.browser(target)
    if not browser.available:
        return ["no browser to replay the scenario with"]
    base_url = toolbox.url_of(target)
    for step in steps[:60]:
        action = step.get("action")
        if action == "navigate":
            url = str(step.get("url") or "")
            # The port changes between launches: keep the path, take the new origin.
            path = re.sub(r"^https?://[^/]+", "", url) or "/"
            answer = await browser.navigate(base_url + path if base_url else url)
            if "error" in answer.lower()[:40] or "failed" in answer.lower()[:40]:
                problems.append(f"navigate {path}: {answer[:120]}")
        elif action in ("click", "fill"):
            snapshot = await browser.snapshot()
            uid = _uid_for(snapshot, str(step.get("text") or ""))
            if not uid:
                problems.append(
                    f"{action}: {step.get('text') or '?'} is no longer on the page"
                )
                continue
            answer = await (
                browser.click(uid)
                if action == "click"
                else browser.fill(uid, str(step.get("value") or ""))
            )
            if answer.startswith("MCP tool error"):
                problems.append(f"{action} {step.get('text')}: {answer[:120]}")
        elif action == "press":
            await browser.press(str(step.get("value") or "Enter"))
        elif action == "wait_for":
            answer = await browser.wait_for([str(step.get("value") or "")])
            if answer.startswith("MCP tool error"):
                problems.append(f"'{step.get('value')}' never appeared")
    for confirmation in record.get("confirmations") or []:
        evidence = str(confirmation.get("evidence") or "").strip()
        if evidence and len(evidence) <= 120 and "\n" not in evidence:
            answer = await browser.wait_for([evidence], timeout_ms=8000)
            if answer.startswith("MCP tool error"):
                problems.append(f"confirmed state no longer shows: {evidence[:80]}")
    return problems


async def _replay_endpoints(toolbox, record: dict) -> list[str]:
    from .endpoints import call_endpoint

    problems: list[str] = []
    for call in record.get("endpoints") or []:
        if call.get("outcome", "called") != "called" or not call.get("ok"):
            continue
        target = toolbox.target(
            call.get("target") or None, ("backend-api", "web-frontend")
        )
        base = toolbox.url_of(target)
        if not base:
            problems.append("the API did not start for the replay")
            break
        result = await asyncio.to_thread(
            call_endpoint,
            base,
            str(call.get("method") or "GET"),
            str(call.get("path") or "/"),
            body=call.get("request_body"),
            expect_status=call.get("expected") or [],
            allow_mutations=toolbox.settings.allow_mutations,
        )
        if result.outcome == "called" and not result.ok:
            problems.append(
                f"{result.method} {result.path}: {result.status} (was {call.get('status')})"
            )
    return problems


async def run_replay(project_dir: Path | str, spec_dir: Path | str) -> dict:
    """Replay and fold the result into the record. Returns the replay entry."""
    project = Path(project_dir).resolve()
    spec = Path(spec_dir).resolve()
    base = work_dir(project, spec)
    record = load_record(base)
    if record is None or record.get("status") not in ("pass", "fail"):
        return {"status": "skipped", "reason": "nothing verified to replay"}
    if not load_settings(project).enabled:
        return {"status": "skipped", "reason": "verification turned off"}
    from .git import fingerprint, head_sha

    head = head_sha(project)
    tree = fingerprint(project)
    if tree and tree == record.get("fingerprint"):
        replay = {
            "status": "skipped",
            "reason": "no change since the verification",
            "at": time.time(),
        }
        record["replay"] = replay
        save_record(base, record)
        return replay

    from .tools import close_toolboxes, toolbox_for

    toolbox = toolbox_for(project, spec)
    detection = detect_targets(project, record.get("changed_files"))
    toolbox._detection = detection
    problems: list[str] = []
    try:
        for target in detection.primary():
            if target.kind == "mobile":
                continue
            result = await asyncio.to_thread(
                launch,
                target,
                project,
                base,
                timeout=float(toolbox.settings.launch_timeout),
            )
            blocking = [e for e in result.errors if e.kind != "environment"]
            if not result.ok:
                problems.append(
                    f"{target.name} did not start: {result.detail or result.status}"
                )
            elif blocking:
                problems += [f"{target.name}: {e.message}" for e in blocking[:5]]
        problems += await _replay_endpoints(toolbox, record)
        problems += await _replay_scenario(toolbox, record)
    finally:
        await close_toolboxes(project)
        stop_all(base)

    replay = {
        "status": "fail" if problems else "pass",
        "problems": problems[:20],
        "head": head,
        "at": time.time(),
    }
    record["replay"] = replay
    record["head"] = head or record.get("head", "")
    record["fingerprint"] = tree
    if problems and record.get("status") == "pass":
        record["status"] = "fail"
        record["reason"] = f"regressed after QA: {problems[0]}"
    save_record(base, record)
    persist_plan_summary(spec, record)
    return replay


async def run_replay_phase(resolved, ctx):
    """`verify-replay` as a workflow phase. Never raises."""
    from workflows.runner import PhaseOutcome

    phase = resolved.phase
    try:
        replay = await run_replay(ctx.project_dir, ctx.spec_dir)
    except Exception as exc:  # noqa: BLE001
        return PhaseOutcome(
            phase.id, phase.impl, resolved.dispatch, None, detail=str(exc)[:200]
        )
    status = replay.get("status")
    if status == "pass":
        return PhaseOutcome(
            phase.id,
            phase.impl,
            resolved.dispatch,
            True,
            detail="the verification still holds",
        )
    if status == "fail":
        return PhaseOutcome(
            phase.id,
            phase.impl,
            resolved.dispatch,
            False,
            detail="; ".join(replay.get("problems") or [])[:200],
        )
    return PhaseOutcome(
        phase.id,
        phase.impl,
        resolved.dispatch,
        None,
        detail=str(replay.get("reason") or status),
    )
