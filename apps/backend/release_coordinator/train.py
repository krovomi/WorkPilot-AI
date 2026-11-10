"""The release train itself: a run that deploys the services one after another.

A run ships the train file's services to one environment in the order of the
graph (waves, critical first). For each service: its ``deploy`` command, then
its ``health`` URL, then its ``smoke`` step; the next service starts only when
all three passed. A service of a production environment, an external service
(the person says it is ready) and every service of an express run wait for the
person's click before anything runs. A flag goes on once all its services
shipped.

When a step fails, the run stops and the person decides: ``retry`` once the
cause is fixed, ``rollback`` (the failed service and every shipped service that
depends on it, dependents first, flags off before), or ``abort`` (what is left
does not ship). An express run (a hotfix outside the train) ships one service
without waiting for its dependencies, after a click, whatever the environment.

Every call drives the run as far as it can go without the person, saving it
after each step, and returns it.
"""

from __future__ import annotations

import os
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import runs
from .flags import switch, token_names
from .gates import StepResult, run_step
from .graph import cascade, plan_order
from .schedule import open_at
from .train_file import TrainFile, TrainService

TERMINAL = {"done", "rolled_back", "rollback_failed", "aborted"}
OPEN_ITEM = {"pending", "waiting_confirmation"}
GATE_STEPS = ("deploy", "health", "smoke")
MAX_JOURNAL = 500


class TrainError(ValueError):
    """A run that cannot start or take this action."""


@dataclass
class Context:
    """What a run needs from outside, replaceable in tests."""

    root: Path
    train: TrainFile
    folders: dict[str, str] = field(default_factory=dict)
    """Service → folder relative to the project (from the manifests)."""
    manifest_deps: dict[str, list[str]] = field(default_factory=dict)
    env: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))
    step_runner: Callable[..., StepResult] = run_step
    flag_switch: Callable[..., dict[str, object]] = switch
    emit: Callable[[str, dict[str, Any]], None] = lambda kind, data: None
    now: Callable[[], datetime] = lambda: datetime.now(UTC)

    def dependencies(self) -> dict[str, set[str]]:
        names = set(self.train.services)
        return {
            name: (set(service.depends_on) | set(self.manifest_deps.get(name, [])))
            & names
            for name, service in self.train.services.items()
        }


def view(ctx: Context) -> dict[str, Any]:
    """The train file as the page shows it: services, waves, problems, variables."""
    train = ctx.train
    order = plan_order(
        {
            name: set(s.depends_on) | set(ctx.manifest_deps.get(name, []))
            for name, s in train.services.items()
        },
        {name: s.criticality for name, s in train.services.items()},
    )
    problems: list[dict[str, object]] = []
    if order.cycle:
        problems.append(
            {
                "code": "cycle",
                "services": order.cycle,
                "cut": list(order.suggestion or []),
            }
        )
    for name, missing in order.unknown.items():
        for dep in missing:
            if dep in train.services[name].depends_on:
                problems.append(
                    {"code": "unknown_dependency", "service": name, "dependency": dep}
                )
    for name, service in train.services.items():
        if not service.external and service.deploy is None:
            problems.append({"code": "no_deploy", "service": name})
    variables = sorted(
        {n for s in train.services.values() for n in s.pass_env}
        | set(token_names(train.flags))
    )
    return {
        "path": train.path,
        "sha256": train.sha256,
        "environments": [
            {"name": n, "production": p} for n, p in train.environments.items()
        ],
        "services": [
            _service_view(s, ctx.folders.get(s.name, ""))
            for s in train.services.values()
        ],
        "order": order.to_dict(),
        "flags": [
            {
                "key": f.key,
                "services": f.services,
                "provider": f.provider,
                "environment": f.environment,
            }
            for f in train.flags
        ],
        "problems": problems,
        "variables": variables,
    }


def _service_view(service: TrainService, folder: str) -> dict[str, Any]:
    return {
        "name": service.name,
        "path": service.path or folder,
        "dependsOn": service.depends_on,
        "criticality": service.criticality,
        "external": service.external,
        "steps": {kind: step.to_dict() for kind, step in service.steps().items()},
        "passEnv": service.pass_env,
    }


def _journal(
    run: dict[str, Any], text: str, service: str = "", kind: str = "info"
) -> None:
    run.setdefault("journal", []).append(
        {"at": runs.now_iso(), "kind": kind, "service": service, "text": text}
    )
    del run["journal"][:-MAX_JOURNAL]


def start(
    ctx: Context,
    environment: str,
    versions: Mapping[str, tuple[str, str]],
    *,
    services: list[str] | None = None,
    express: bool = False,
) -> dict[str, Any]:
    """A new run (saved, not driven yet). ``versions``: service → (current, next)."""
    train = ctx.train
    if environment not in train.environments:
        raise TrainError(f"the train file has no environment {environment}")
    chosen = services or list(train.services)
    unknown = [s for s in chosen if s not in train.services]
    if unknown:
        raise TrainError(f"the train file has no service {unknown[0]}")
    if express and len(chosen) != 1:
        raise TrainError("an express deploy ships exactly one service")
    if not chosen:
        raise TrainError("the train file lists no service")
    for other in runs.list_runs(ctx.root):
        if (
            other.get("environment") == environment
            and other.get("status") not in TERMINAL
        ):
            raise TrainError(
                f"run {other.get('id')} is still open on {environment}: finish or abort it first"
            )
    deps = ctx.dependencies()
    order = plan_order(
        {name: deps[name] & set(chosen) for name in chosen},
        {name: train.services[name].criticality for name in chosen},
    )
    if order.cycle:
        raise TrainError(
            "the dependencies form a cycle: "
            + " → ".join([*order.cycle, order.cycle[0]])
        )
    missing_deploy = [
        n
        for n in chosen
        if not train.services[n].external and train.services[n].deploy is None
    ]
    if missing_deploy:
        raise TrainError(f"{missing_deploy[0]} has no deploy command")
    production = train.environments[environment]
    shipped_before = runs.last_shipped(ctx.root, environment)
    stamp = ctx.now().strftime("%Y%m%d-%H%M%S")
    run: dict[str, Any] = {
        "id": f"rt-{stamp}-{secrets.token_hex(3)}",
        "environment": environment,
        "production": production,
        "express": express,
        "status": "running",
        "createdAt": runs.now_iso(),
        "startedAt": runs.now_iso(),
        "trainSha": train.sha256,
        "gateFailures": 0,
        "blocked": None,
        "warnings": [],
        "items": [],
        "flags": [],
        "journal": [],
    }
    for wave_index, wave in enumerate(order.waves):
        for name in wave:
            service = train.services[name]
            current, following = versions.get(name, ("", ""))
            run["items"].append(
                {
                    "service": name,
                    "wave": wave_index,
                    "version": following or current,
                    "previousVersion": shipped_before.get(name) or current,
                    "external": service.external,
                    "confirm": production or service.external or express,
                    "confirmed": False,
                    "status": "pending",
                    "phase": "",
                    "steps": {},
                    "rollback": None,
                    "detail": "",
                }
            )
    for flag in train.flags:
        named = [s for s in flag.services if s in chosen]
        if named and not express:
            run["flags"].append(
                {
                    "key": flag.key,
                    "provider": flag.provider,
                    "services": named,
                    "state": "off",
                    "results": [],
                }
            )
    for slot in open_at(train.calendar, environment, ctx.now()):
        if slot.service not in chosen:
            run["warnings"].append(
                {"code": "calendar", "service": slot.service, "at": slot.at.isoformat()}
            )
    _journal(run, "express deploy" if express else f"train started on {environment}")
    runs.save(ctx.root, run)
    return run


def _item(run: dict[str, Any], name: str) -> dict[str, Any]:
    for item in run["items"]:
        if item["service"] == name:
            return item
    raise TrainError(f"the run has no service {name}")


def _flag(run: dict[str, Any], key: str) -> dict[str, Any]:
    for flag in run["flags"]:
        if flag["key"] == key:
            return flag
    raise TrainError(f"the run has no flag {key}")


def _finish(ctx: Context, run: dict[str, Any], status: str) -> None:
    run["status"] = status
    run["endedAt"] = runs.now_iso()
    run["blocked"] = None
    try:
        started = datetime.fromisoformat(str(run["startedAt"]))
        minutes = round(
            (datetime.fromisoformat(run["endedAt"]) - started).total_seconds() / 60, 1
        )
    except (KeyError, ValueError):
        minutes = 0.0
    runs.save(ctx.root, run)
    runs.record(
        ctx.root,
        {
            "id": run["id"],
            "environment": run["environment"],
            "status": status,
            "express": run.get("express", False),
            "startedAt": run.get("startedAt"),
            "endedAt": run["endedAt"],
            "minutes": minutes,
            "services": len(run["items"]),
            "gateFailures": run.get("gateFailures", 0),
            "shipped": {
                i["service"]: i["version"]
                for i in run["items"]
                if i["status"] == "done" and i["version"]
            },
            "rolledBack": {
                i["service"]: i["previousVersion"]
                for i in run["items"]
                if i["status"] == "rolled_back" and i["previousVersion"]
            },
        },
    )
    ctx.emit("finished", {"status": status})


def _values(
    run: dict[str, Any], item: dict[str, Any], rollback: bool = False
) -> dict[str, str]:
    return {
        "environment": run["environment"],
        "service": item["service"],
        "version": item["previousVersion"] if rollback else item["version"],
        "previous_version": item["previousVersion"],
    }


def _run(
    ctx: Context,
    run: dict[str, Any],
    item: dict[str, Any],
    kind: str,
    rollback: bool = False,
) -> StepResult:
    service = ctx.train.services[item["service"]]
    step = service.rollback if rollback else service.steps()[kind]
    assert step is not None
    return ctx.step_runner(
        step,
        root=ctx.root,
        folder=service.path or ctx.folders.get(service.name, ""),
        values=_values(run, item, rollback),
        pass_env=service.pass_env,
        source_env=ctx.env,
    )


def _block(run: dict[str, Any], kind: str, name: str, step: str, detail: str) -> None:
    run["status"] = "blocked"
    run["blocked"] = {"kind": kind, "name": name, "step": step, "detail": detail}


def _flags_forward(ctx: Context, run: dict[str, Any]) -> bool:
    """Switch on the flags whose services all shipped; False when the run must stop."""
    done = {i["service"] for i in run["items"] if i["status"] == "done"}
    by_key = {f.key: f for f in ctx.train.flags}
    for state in run["flags"]:
        if (
            state["state"] not in ("off", "confirmed")
            or not set(state["services"]) <= done
        ):
            continue
        flag = by_key.get(state["key"])
        if flag is None:
            continue
        if flag.provider == "manual" and state["state"] != "confirmed":
            state["state"] = "waiting"
            run["status"] = "waiting"
            _journal(run, f"turn flag {flag.key} on, then confirm", kind="ask")
            return False
        result = ctx.flag_switch(flag, True, run["environment"], ctx.env)
        state["results"].append({**result, "at": runs.now_iso()})
        if result["status"] in ("done", "manual"):
            state["state"] = "on"
            _journal(run, f"flag {flag.key} on")
            continue
        state["state"] = "failed"
        _block(run, "flag", flag.key, "flag", str(result.get("detail", "")))
        _journal(
            run,
            f"flag {flag.key} could not be turned on: {result.get('detail', '')}",
            kind="error",
        )
        return False
    return True


def _forward(ctx: Context, run: dict[str, Any]) -> None:
    while run["status"] not in TERMINAL:
        if run["status"] == "blocked":
            runs.save(ctx.root, run)
            return
        if not _flags_forward(ctx, run):
            runs.save(ctx.root, run)
            return
        item = next((i for i in run["items"] if i["status"] in OPEN_ITEM), None)
        if item is None:
            _journal(run, "train done")
            _finish(ctx, run, "done")
            return
        name = item["service"]
        if item["confirm"] and not item["confirmed"]:
            item["status"] = "waiting_confirmation"
            run["status"] = "waiting"
            _journal(run, "waiting for your go", name, "ask")
            runs.save(ctx.root, run)
            ctx.emit("waiting", {"service": name})
            return
        run["status"] = "running"
        item["startedAt"] = runs.now_iso()
        if item["external"]:
            item["status"] = "done"
            item["endedAt"] = runs.now_iso()
            _journal(run, "confirmed ready (external service)", name)
            runs.save(ctx.root, run)
            continue
        item["status"] = "deploying"
        for kind in GATE_STEPS:
            if kind not in ctx.train.services[name].steps():
                continue
            item["phase"] = kind
            runs.save(ctx.root, run)
            ctx.emit("step", {"service": name, "step": kind})
            result = _run(ctx, run, item, kind)
            item["steps"][kind] = result.to_dict()
            if not result.ok:
                item["status"] = "failed"
                item["detail"] = result.detail
                if kind != "deploy":
                    run["gateFailures"] = int(run.get("gateFailures", 0)) + 1
                _block(run, "service", name, kind, result.detail)
                _journal(run, f"{kind} failed: {result.detail}", name, "error")
                runs.save(ctx.root, run)
                ctx.emit("blocked", {"service": name, "step": kind})
                return
        item["status"] = "done"
        item["phase"] = ""
        item["endedAt"] = runs.now_iso()
        _journal(run, f"shipped {item['version']}".strip(), name)
        runs.save(ctx.root, run)


def _rollback(ctx: Context, run: dict[str, Any], name: str) -> None:
    item = _item(run, name)
    if item["status"] not in ("done", "failed"):
        raise TrainError(f"{name} has not shipped: nothing to roll back")
    order = [i["service"] for i in run["items"]]
    shipped = [i["service"] for i in run["items"] if i["status"] in ("done", "failed")]
    targets = cascade(ctx.dependencies(), name, shipped, order)
    by_key = {f.key: f for f in ctx.train.flags}
    for state in run["flags"]:
        flag = by_key.get(state["key"])
        if (
            flag is None
            or state["state"] != "on"
            or not set(state["services"]) & set(targets)
        ):
            continue
        result = ctx.flag_switch(flag, False, run["environment"], ctx.env)
        state["results"].append({**result, "at": runs.now_iso()})
        state["state"] = "off" if result["status"] == "done" else "failed"
        text = (
            "off"
            if result["status"] == "done"
            else "to turn off by hand"
            if result["status"] == "manual"
            else f"could not be turned off: {result.get('detail', '')}"
        )
        _journal(
            run,
            f"flag {flag.key} {text}",
            kind="info" if result["status"] == "done" else "ask",
        )
    failed = False
    _journal(run, "rolling back " + ", ".join(targets))
    for target in targets:
        entry = _item(run, target)
        service = ctx.train.services[target]
        if entry["external"]:
            entry["status"] = "rolled_back"
            entry["detail"] = "external service: roll it back by hand"
            _journal(run, entry["detail"], target, "ask")
            continue
        if service.rollback is None:
            entry["status"] = "rollback_failed"
            entry["detail"] = "no rollback command in the train file"
            failed = True
            _journal(run, entry["detail"], target, "error")
            continue
        entry["phase"] = "rollback"
        runs.save(ctx.root, run)
        ctx.emit("step", {"service": target, "step": "rollback"})
        result = _run(ctx, run, entry, "rollback", rollback=True)
        entry["rollback"] = result.to_dict()
        entry["phase"] = ""
        entry["status"] = "rolled_back" if result.ok else "rollback_failed"
        entry["detail"] = result.detail
        failed = failed or not result.ok
        _journal(
            run,
            "rolled back" if result.ok else f"rollback failed: {result.detail}",
            target,
            "info" if result.ok else "error",
        )
    for entry in run["items"]:
        if entry["status"] in OPEN_ITEM:
            entry["status"] = "skipped"
    _finish(ctx, run, "rollback_failed" if failed else "rolled_back")


def _recover(run: dict[str, Any]) -> None:
    """A step the previous process was on when it stopped did not finish."""
    for item in run["items"]:
        if item["status"] == "deploying":
            item["status"] = "failed"
            item["detail"] = "interrupted: the app stopped during this step"
            _block(
                run,
                "service",
                item["service"],
                item.get("phase") or "deploy",
                item["detail"],
            )
            _journal(run, item["detail"], item["service"], "error")


def drive(
    ctx: Context, run_id: str, action: str = "continue", target: str = ""
) -> dict[str, Any]:
    """Take ``action`` on the run, then drive it until it needs the person."""
    with runs.RunLock(ctx.root, run_id):
        run = runs.load(ctx.root, run_id)
        _recover(run)
        if run["status"] in TERMINAL:
            raise TrainError("this run is over")
        if action == "confirm":
            if target.startswith("flag:"):
                state = _flag(run, target[5:])
                if state["state"] != "waiting":
                    raise TrainError("this flag is not waiting for you")
                state["state"] = "confirmed"
                _journal(run, f"flag {state['key']} turned on by hand")
            else:
                item = _item(run, target)
                if item["status"] != "waiting_confirmation":
                    raise TrainError(f"{target} is not waiting for you")
                item["confirmed"] = True
                item["status"] = "pending"
                _journal(run, "go given", target)
            run["status"] = "running"
        elif action == "retry":
            if not run["blocked"]:
                raise TrainError("nothing failed")
            blocked = run["blocked"]
            if blocked["kind"] == "flag":
                _flag(run, blocked["name"])["state"] = "off"
            else:
                item = _item(run, blocked["name"])
                item["status"] = "pending"
                item["steps"] = {}
                item["detail"] = ""
            run["blocked"] = None
            run["status"] = "running"
            _journal(run, "retry", blocked["name"])
        elif action == "rollback":
            blocked = run["blocked"] or {}
            name = target or (
                blocked.get("name", "") if blocked.get("kind") == "service" else ""
            )
            if not name:
                raise TrainError("name the service to roll back")
            _rollback(ctx, run, name)
            return run
        elif action == "abort":
            for item in run["items"]:
                if item["status"] in OPEN_ITEM:
                    item["status"] = "skipped"
            _journal(run, "train stopped: the rest does not ship")
            _finish(ctx, run, "aborted")
            return run
        elif action != "continue":
            raise TrainError(f"unknown action {action}")
        runs.save(ctx.root, run)
        _forward(ctx, run)
        return run


__all__ = ["Context", "TERMINAL", "TrainError", "drive", "start", "view"]
