"""Compare what the task does with what its base branch does (prospective P8).

The verification proves the task's app reaches the state the card asked for.
A reviewer then wants the other half: *what did the change change?* This
module replays the same recorded scenario and the same endpoint calls twice,
without a model: once on the code the branch forked from, once on the task,
and lists the differences in behaviour:

* a scenario step or a confirmed state that works on one side only
  (``broken``: it worked before the task; ``fixed``: it works thanks to it);
* console errors and warnings that appear or disappear;
* network requests that appear, disappear or answer another status;
* endpoint calls that answer another status;
* the page at the end of the scenario, on each side, as a capture.

The base side runs in a detached git worktree of the merge base, prepared by
the same worktree recipe as the task's (dependencies linked, ports reserved),
so it works for any stack the verification can launch. The two sides run one
after the other, never together: a dev server with a fixed port must not see
its twin.

A comparison is evidence for the reviewer, never a gate: it does not change
the record's status. Both sides start from their own data, which is what a
reviewer gets by checking out the branch; differences caused by data are
possible and the panel says so.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from foundation.git_executable import run_git

from .record import load_record, save_record
from .settings import load_settings
from .state import stop_all, work_dir

logger = logging.getLogger(__name__)

__all__ = [
    "MAX_DIFFERENCES",
    "console_entries",
    "diff_sides",
    "network_entries",
    "run_base_comparison",
]

MAX_DIFFERENCES = 60
MAX_ENTRIES = 200
_MAX_TEXT = 300
_SPEC_NAME = re.compile(r"^[\w.-]{1,120}$")
#: A loopback origin: its port changes between two launches, so it is dropped.
_LOOPBACK = re.compile(
    r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?", re.I
)
#: A bundler's content hash in an asset name (`index-B1x2y3z4.js`).
_HASHED = re.compile(
    r"([.-])[A-Za-z0-9_]{8,}(?=\.(?:js|mjs|cjs|css|map|woff2?|ttf|png|svg|jpe?g|webp)\b)"
)
#: Where in the source a message came from: it moves with any edit.
_POSITION = re.compile(r":\d+(?::\d+)?\b")
_CONSOLE = re.compile(r"\[(error|warn|warning|issue)\]\s*(.*)$", re.I)
_NETWORK = re.compile(r"^(?:reqid=\S+\s+)?([A-Z]{3,7})\s+(\S+)\s+\[([^\]]*)\]")

Observe = Callable[[Path, Path, dict, Path], Awaitable[dict]]


def _clean(text: str) -> str:
    text = _LOOPBACK.sub("", text)
    text = _HASHED.sub(r"\1*", text)
    return re.sub(r"\s+", " ", text).strip()[:_MAX_TEXT]


def console_entries(listing: str) -> list[str]:
    """The errors and warnings of a console listing, comparable across launches."""
    seen: list[str] = []
    for line in (listing or "").splitlines():
        match = _CONSOLE.search(line)
        if not match:
            continue
        level = "warning" if match.group(1).lower().startswith("warn") else "error"
        message = re.sub(r"\s*\(\d+ args?\)\s*$", "", match.group(2))
        entry = f"[{level}] {_POSITION.sub('', _clean(message))}"
        if entry not in seen:
            seen.append(entry)
        if len(seen) == MAX_ENTRIES:
            break
    return seen


def _status(text: str) -> str:
    code = re.search(r"\b([1-5]\d\d)\b", text)
    if code:
        return code.group(1)
    lowered = text.lower()
    if "pending" in lowered:
        return "pending"
    return "failed" if ("fail" in lowered or "err" in lowered) else lowered[:40]


def network_entries(listing: str) -> dict[str, str]:
    """``"METHOD /path"`` → status of a request listing, comparable across launches.

    The origin of a loopback URL, the query string and a bundler's hash are
    dropped: they change between two launches of the same code."""
    out: dict[str, str] = {}
    for line in (listing or "").splitlines():
        match = _NETWORK.match(line.strip())
        if not match:
            continue
        url = match.group(2)
        if url.startswith(("data:", "blob:", "chrome-extension:")):
            continue
        path = _clean(url.split("#", 1)[0].split("?", 1)[0]) or "/"
        out[f"{match.group(1)} {path}"] = _status(match.group(3))
        if len(out) == MAX_ENTRIES:
            break
    return out


def _endpoint_map(calls: list[dict]) -> dict[str, str]:
    return {
        f"{c.get('method') or 'GET'} {c.get('path') or '/'}": (
            str(c["status"]) if c.get("status") is not None else "failed"
        )
        for c in calls
    }


def _changed(kind: str, base: dict[str, str], task: dict[str, str]) -> list[dict]:
    out: list[dict] = []
    for key in sorted(set(base) | set(task)):
        before, after = base.get(key), task.get(key)
        if "pending" in (before, after) or before == after:
            continue
        change = (
            "added" if before is None else "removed" if after is None else "changed"
        )
        out.append(
            {"kind": kind, "change": change, "what": key, "base": before, "task": after}
        )
    return out


def diff_sides(base: dict, task: dict) -> list[dict]:
    """The behaviour that differs between the two observations, bounded."""
    differences: list[dict] = []
    base_problems, task_problems = (
        base.get("problems") or [],
        task.get("problems") or [],
    )
    differences += [
        {"kind": "scenario", "change": "broken", "what": p}
        for p in task_problems
        if p not in base_problems
    ]
    differences += [
        {"kind": "scenario", "change": "fixed", "what": p}
        for p in base_problems
        if p not in task_problems
    ]
    base_console, task_console = base.get("console") or [], task.get("console") or []
    differences += [
        {"kind": "console", "change": "added", "what": c}
        for c in task_console
        if c not in base_console
    ]
    differences += [
        {"kind": "console", "change": "removed", "what": c}
        for c in base_console
        if c not in task_console
    ]
    differences += _changed(
        "endpoint",
        _endpoint_map(base.get("endpoints") or []),
        _endpoint_map(task.get("endpoints") or []),
    )
    differences += _changed(
        "network", base.get("network") or {}, task.get("network") or {}
    )
    return differences[:MAX_DIFFERENCES]


# -- one side ----------------------------------------------------------------


async def _observe_endpoints(toolbox, record: dict) -> list[dict]:
    from .endpoints import call_endpoint

    out: list[dict] = []
    for call in (record.get("endpoints") or [])[:30]:
        if call.get("outcome", "called") != "called":
            continue
        method = str(call.get("method") or "GET")
        path = str(call.get("path") or "/")
        target = toolbox.target(
            call.get("target") or None, ("backend-api", "web-frontend")
        )
        base_url = toolbox.url_of(target)
        if not base_url:
            out.append({"method": method, "path": path, "status": None})
            continue
        result = await asyncio.to_thread(
            call_endpoint,
            base_url,
            method,
            path,
            body=call.get("request_body"),
            expect_status=call.get("expected") or [],
            allow_mutations=toolbox.settings.allow_mutations,
        )
        if result.outcome == "called":
            out.append(
                {"method": result.method, "path": result.path, "status": result.status}
            )
    return out


async def observe_side(
    code_dir: Path, side_spec: Path, record: dict, shot: Path
) -> dict:
    """Launch ``code_dir``, replay the record's scenario and calls, and say what was seen."""
    from .detect import detect_targets
    from .replay import launch_targets, replay_scenario
    from .tools import close_toolboxes, toolbox_for

    toolbox = toolbox_for(code_dir, side_spec)
    # Both sides follow the project's settings, not whatever the base checkout reads.
    toolbox.settings = load_settings(record.get("_project_dir") or code_dir)
    detection = detect_targets(code_dir, record.get("changed_files"))
    toolbox._detection = detection
    seen: dict = {"problems": [], "console": [], "network": {}, "endpoints": []}
    try:
        seen["problems"] += await launch_targets(
            toolbox, detection, code_dir, toolbox.base
        )
        seen["endpoints"] = await _observe_endpoints(toolbox, record)
        steps = [
            s
            for s in record.get("scenario") or []
            if not str(s.get("action") or "").startswith("window_")
        ]
        seen["problems"] += await replay_scenario(toolbox, record)
        if steps:
            browser = await toolbox.browser(
                toolbox.target(None, ("web-frontend", "desktop"))
            )
            if browser.available:
                seen["console"] = console_entries(await browser.console())
                seen["network"] = network_entries(await browser.network())
                if await browser.screenshot(shot):
                    seen["screenshot"] = str(shot)
    finally:
        await close_toolboxes(code_dir)
        stop_all(toolbox.base)
    return seen


# -- the base checkout -------------------------------------------------------


def _git_ok(cwd: Path, *args: str, timeout: int = 120) -> bool:
    try:
        return run_git(list(args), cwd=cwd, timeout=timeout).returncode == 0
    except (OSError, ValueError) as exc:
        logger.debug("[verify-compare] git %s failed: %s", args[:2], exc)
        return False


def _checkout_dir(main: Path, spec_name: str) -> Path:
    """Where the base side is checked out: inside the project's ignored
    ``.workpilot/``, never through a link."""
    if not _SPEC_NAME.fullmatch(spec_name):
        raise ValueError("unexpected spec name")
    root = main.resolve()
    folder = root / ".workpilot" / "verify-base"
    for step in (root / ".workpilot", folder):
        if step.is_symlink():
            raise ValueError(f"{step.name} is a link")
    return folder / spec_name


def _unlink(checkout: Path, linked: list[str]) -> None:
    """Remove the dependency links the recipe made, before the checkout is
    deleted: deleting it must never walk into the project's folders."""
    isjunction = getattr(os.path, "isjunction", lambda _p: False)
    for rel in linked:
        link = checkout / rel
        try:
            if link.is_symlink():
                link.unlink()
            elif isjunction(link):
                os.rmdir(link)
        except OSError as exc:
            logger.warning(
                "[verify-compare] could not remove the link %s: %s", rel, exc
            )


def _remove_checkout(project: Path, checkout: Path, linked: list[str]) -> None:
    _unlink(checkout, linked)
    if checkout.exists() or checkout.is_symlink():
        _git_ok(project, "worktree", "remove", "--force", str(checkout))
    if checkout.exists() and not checkout.is_symlink():
        shutil.rmtree(checkout, ignore_errors=True)
    _git_ok(project, "worktree", "prune")


def _side_spec(spec: Path, side: str) -> Path:
    """A spec folder of its own for each side: its state, logs and browser
    never mix with the verification's, and it carries the card's window title
    but not its scenario, so the verification's trace and video stay as they are."""
    folder = work_dir(spec.parent, spec) / "compare" / side
    folder.mkdir(parents=True, exist_ok=True)
    from .window import CARD_FIELD, card_window

    title = card_window(spec)
    metadata = folder / "task_metadata.json"
    import json

    metadata.write_text(
        json.dumps({CARD_FIELD: title} if title else {}), encoding="utf-8"
    )
    return folder


def _skipped(base: Path, record: dict, reason: str) -> dict:
    entry = {"status": "skipped", "reason": reason, "at": time.time()}
    record["compare"] = entry
    save_record(base, record)
    return entry


def _attach_shots(record: dict, seen: dict[str, dict]) -> dict:
    """The two end-of-scenario captures in the record's screenshots, replacing
    the previous comparison's; their indices for the panel."""
    shots = [s for s in record.get("screenshots") or [] if not s.get("compare")]
    indices: dict[str, int | None] = {"base": None, "task": None}
    for side, label in (("base", "Base branch"), ("task", "This task")):
        path = seen[side].get("screenshot")
        if path:
            indices[side] = len(shots)
            shots.append(
                {"path": path, "label": label, "platform": "web", "compare": side}
            )
    record["screenshots"] = shots
    return indices


async def run_base_comparison(
    project_dir: Path | str,
    spec_dir: Path | str,
    *,
    observe: Observe | None = None,
) -> dict:
    """Replay the verification on the base branch and on the task; fold the
    differences into the record (``compare``). Returns that entry. Never raises
    for an expected refusal: it answers ``skipped`` with the reason."""
    from core.workspace.ports import release_ports
    from core.workspace.recipe_run import prepare_worktree

    from .git import base_commit, fingerprint, head_sha, main_checkout

    observe = observe or observe_side
    project = Path(project_dir).resolve()
    spec = Path(spec_dir).resolve()
    base = work_dir(project, spec)
    record = load_record(base)
    if record is None or record.get("status") not in ("pass", "fail"):
        return {"status": "skipped", "reason": "nothing verified to compare"}
    if not load_settings(project).enabled:
        return _skipped(base, record, "verification turned off")
    if not record.get("scenario") and not record.get("endpoints"):
        return _skipped(
            base, record, "the verification recorded no scenario and no endpoint call"
        )
    sha = base_commit(project)
    if not sha:
        return _skipped(base, record, "no base branch found")
    head = head_sha(project)
    main = main_checkout(project) or project
    try:
        checkout = _checkout_dir(main, spec.name)
    except ValueError as exc:
        return _skipped(base, record, f"no place for the base checkout: {exc}")

    shots = base / "compare"
    shots.mkdir(parents=True, exist_ok=True)
    port_key = f"{spec.name}-base"
    linked: list[str] = []
    seen: dict[str, dict] = {}
    try:
        _remove_checkout(project, checkout, [])
        checkout.parent.mkdir(parents=True, exist_ok=True)
        if not _git_ok(
            project, "worktree", "add", "--detach", "--force", str(checkout), sha
        ):
            return _skipped(base, record, "the base branch could not be checked out")
        report = await asyncio.to_thread(prepare_worktree, main, checkout, port_key)
        linked = list(report.linked)
        context = {**record, "_project_dir": str(project)}
        seen["base"] = await observe(
            checkout, _side_spec(spec, "base"), context, shots / "base.png"
        )
        seen["task"] = await observe(
            project, _side_spec(spec, "task"), context, shots / "task.png"
        )
    finally:
        _remove_checkout(project, checkout, linked)
        release_ports(main, port_key)

    # The record may have moved while the app ran (a re-run): fold into the latest.
    record = load_record(base) or record
    differences = diff_sides(seen["base"], seen["task"])
    entry = {
        "status": "done",
        "base": sha,
        "head": head,
        "fingerprint": fingerprint(project),
        "at": time.time(),
        "differences": differences,
        "base_problems": (seen["base"].get("problems") or [])[:10],
        "task_problems": (seen["task"].get("problems") or [])[:10],
        "screenshots": _attach_shots(record, seen),
    }
    record["compare"] = entry
    save_record(base, record)
    return entry
