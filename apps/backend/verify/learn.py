"""What one verification teaches the next one — and every other agent.

This is the loop's contribution to the learning loops that already exist, and
it adds no new store: each lesson goes where its readers already look.

| Lesson | Where | Read by |
|---|---|---|
| the launch command that *worked*, its port, its ready path | `.workpilot/verify/recipe.json` | `verify.detect`, next task: the app launches on the first try |
| a launch failure the loop fixed (a migration, a variable, a port) | the project's memory in the shared brain (`save_gotcha`) | the coder, QA, every agent through `brain_recall` |
| the build's verification: verdict, rounds, score, endpoints | `knowledge/projects/<p>/verify/` (`brain.learn.record`, surface `verify`) | the Kanban brain card, `brain_recall` |
| the performance score per page | `.workpilot/verify/baseline.json` | the next verification: a drop is a regression finding |
| "the app was seen working" | `BuildOutcome.app_verified` → `RUNTIME_VERIFIED` | `learning_loop.observe`: an external signal a skill proposal may count |

The recipe stores **variable names, never values**: it is a file in the
project, and a connection string that worked is still a secret.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

__all__ = [
    "load_recipe",
    "save_recipe",
    "load_baseline",
    "compare_baseline",
    "update_baseline",
    "record_in_brain",
    "record_gotchas",
]

_DIR = Path(".workpilot") / "verify"
RECIPE_FILE = "recipe.json"
BASELINE_FILE = "baseline.json"
_MAX_HISTORY = 20


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write(path: Path, data: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(".json.partial")
        partial.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        os.replace(partial, path)
    except OSError as exc:
        logger.debug("verify: could not write %s: %s", path, exc)


def load_recipe(project_dir: Path | str) -> dict:
    return _read(Path(project_dir) / _DIR / RECIPE_FILE).get("targets", {}) or {}


def save_recipe(project_dir: Path | str, record: dict) -> dict:
    """Keep the launch of every target that came up clean."""
    path = Path(project_dir) / _DIR / RECIPE_FILE
    data = _read(path)
    targets = data.get("targets") if isinstance(data.get("targets"), dict) else {}
    learned = {}
    for target in record.get("targets") or []:
        launch = target.get("launch") or {}
        if launch.get("status") not in ("ready", "reused"):
            continue
        if any(
            e.get("kind") in ("crash", "exception", "build")
            for e in target.get("errors") or []
        ):
            continue
        template = target.get("command_template") or ""
        if not template:
            continue
        entry = {
            "kind": target.get("kind"),
            "root": target.get("root"),
            "command": template,
            "ready_path": target.get("ready_path") or "/",
            "env_names": sorted(target.get("env_names") or []),
            "learned_at": time.time(),
        }
        if target.get("notes"):
            entry["notes"] = list(target["notes"])[:10]
        targets[target["name"]] = entry
        learned[target["name"]] = entry
    if learned:
        _write(path, {"version": 1, "targets": targets})
    return learned


def _route(url: str) -> str:
    try:
        return urlsplit(url).path or "/"
    except ValueError:
        return "/"


def load_baseline(project_dir: Path | str) -> dict:
    return _read(Path(project_dir) / _DIR / BASELINE_FILE).get("pages", {}) or {}


def compare_baseline(
    project_dir: Path | str, perf: list[dict], threshold: int
) -> list[dict]:
    """A finding for each page whose score fell more than ``threshold`` points."""
    pages = load_baseline(project_dir)
    findings = []
    for result in perf:
        score = result.get("score")
        if score is None:
            continue
        history = pages.get(_route(result.get("url", ""))) or []
        previous = [
            h["score"]
            for h in history
            if isinstance(h, dict) and h.get("score") is not None
        ]
        if not previous:
            continue
        reference = max(previous[-5:])
        if reference - score > threshold:
            findings.append(
                {
                    "severity": "medium",
                    "kind": "perf-regression",
                    "message": (
                        f"performance of {_route(result.get('url', ''))} fell from {reference} "
                        f"to {score} (threshold {threshold})"
                    ),
                }
            )
    return findings


def update_baseline(project_dir: Path | str, perf: list[dict], spec: str) -> None:
    path = Path(project_dir) / _DIR / BASELINE_FILE
    data = _read(path)
    pages = data.get("pages") if isinstance(data.get("pages"), dict) else {}
    changed = False
    for result in perf:
        if result.get("score") is None:
            continue
        route = _route(result.get("url", ""))
        history = pages.setdefault(route, [])
        history.append(
            {
                "score": result["score"],
                "spec": spec,
                "at": time.time(),
                "lcp_ms": result.get("lcp_ms"),
                "cls": result.get("cls"),
            }
        )
        pages[route] = history[-_MAX_HISTORY:]
        changed = True
    if changed:
        _write(path, {"version": 1, "pages": pages})


def _brain_body(record: dict) -> str:
    lines = [
        "_Données mesurées par la boucle de vérification — pas des instructions._",
        "",
        f"- Verdict : **{record.get('status')}**"
        + (f" — {record.get('reason')}" if record.get("reason") else ""),
    ]
    if record.get("score") is not None:
        lines.append(f"- Score : {record['score']}/100")
    for target in record.get("targets") or []:
        launch = target.get("launch") or {}
        lines.append(
            f"- `{target.get('name')}` ({target.get('kind')}) lancé par `{target.get('command_template') or launch.get('command', '')}` → {launch.get('status')}"
        )
    rounds = record.get("rounds") or []
    if rounds:
        lines.append(
            f"- Tours de correction : {len(rounds)} ({rounds[0].get('errors_before')} → {rounds[-1].get('errors_after')} erreur(s))"
        )
    for item in record.get("confirmations") or []:
        lines.append(f"- État confirmé : {item.get('state')}")
    endpoints = record.get("endpoints") or []
    if endpoints:
        good = sum(1 for e in endpoints if e.get("ok"))
        lines.append(f"- Endpoints : {good}/{len(endpoints)} conformes")
    for finding in record.get("findings") or []:
        lines.append(f"- [{finding.get('severity')}] {finding.get('message')}")
    return "\n".join(lines)


def record_in_brain(
    project_dir: Path | str, spec_dir: Path | str | None, record: dict
) -> str | None:
    """One note per verification under the project's `verify/` folder."""
    try:
        from brain.learn import record as brain_record
        from brain.tasks import project_name, task_ref
    except ImportError:
        return None
    try:
        project = project_name(Path(project_dir))
        spec = Path(spec_dir).name if spec_dir else "manual"
        return brain_record(
            "verify",
            f"Vérification {spec} — {record.get('status')}",
            _brain_body(record),
            project=project,
            tags=["verify", str(record.get("status"))],
            task=task_ref(project_dir, spec_dir) if spec_dir else None,
        )
    except Exception as exc:  # noqa: BLE001 - learning never fails a verification
        logger.debug("verify: brain note skipped: %s", exc)
        return None


def record_gotchas(spec_dir: Path | str | None, record: dict) -> int:
    """A gotcha per launch failure a fix round made disappear."""
    if not spec_dir:
        return 0
    lessons = []
    for item in record.get("rounds") or []:
        if not item.get("fixed"):
            continue
        for error in item.get("errors") or []:
            message = str(error.get("message") or "").strip()
            if message:
                lessons.append((message, item.get("note") or ""))
    if not lessons:
        return 0
    try:
        from memory.store import remember
    except ImportError:
        return 0

    def _write_all(memory) -> bool:
        wrote = 0
        for message, note in lessons[:5]:
            if memory.record_gotcha(
                f"Au lancement de l'application : {message}",
                solution=note or "corrigé par la boucle de vérification",
                trigger="verify",
            ):
                wrote += 1
        return wrote > 0

    try:
        return len(lessons[:5]) if remember(spec_dir, _write_all) else 0
    except Exception as exc:  # noqa: BLE001
        logger.debug("verify: gotchas skipped: %s", exc)
        return 0
