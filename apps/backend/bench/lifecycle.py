"""A bench run, from the cards chosen to the table.

1. ``discover``: for each finished card, its target commit, its base and its
   hidden tests, or why it cannot be a case (no target found, no test
   changed). Git only, nothing runs.
2. ``prepare``: calibration, then the copies. Each case's tests run twice on
   a copy at the target and once on a copy at the base with the card's tests
   on top. A test that passes both times at the target and fails at the base
   is *fail-to-pass* (F2P), one that passes everywhere *pass-to-pass* (P2P).
   A case without F2P is set aside with its reason: a judge that does not
   tell the card's work from its absence judges nothing. Then one copy per
   case × engine, at the base, with the card's spec (``copy_spec``).
3. The builds: ordinary ``run.py`` processes started by the app in each copy
   (``--direct``), with the engine written in the spec's metadata.
4. ``judge``: per build, once it ended. The test files the agent touched go
   back to the base's, the card's tests are put on top, the suites run, and
   the build *resolves* the case when every F2P and every P2P test passes.
   When the last build is judged, the records join the table and the copies
   are removed (the logs stay).

The manifest, ``<project>/.workpilot/bench/runs/<run>.json``, is written by
this module only; the app reads it.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from . import judge as judging
from . import repo
from .layout import (
    BUILD_ID,
    COMMIT,
    SPEC_ID,
    BenchError,
    check_run_id,
    manifest_path,
    new_run_id,
    now,
    read_json,
    work_dir,
    write_json,
)
from .results import add_records

MAX_CASES = 20
# Cards looked at to offer candidates: discovery runs git only.
MAX_CANDIDATES = 60
MAX_VARIANTS = 4
VARIANT_DEPTH = 50
ENGINE_PHASES = ("spec", "planning", "coding", "qa")
# What the spec pipeline wrote before any build. The plan, the QA reports, the
# logs and the memory of the build are not copied: they describe the answer.
SPEC_FILES = (
    "spec.md",
    "requirements.json",
    "complexity_assessment.json",
    "context.json",
    "project_index.json",
)
# Task metadata a replay keeps: what kind of task it is, never where it went.
METADATA_KEYS = ("kind", "kindSource", "category", "priority", "complexity", "impact")

_PROVIDER = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_EFFORT = re.compile(r"^[a-z][a-z_-]{0,31}$")


@dataclass(frozen=True)
class Engine:
    provider: str
    model: str
    effort: str

    def metadata(self) -> dict:
        """The keys ``buildEngineMetadata`` writes in the renderer."""
        return {
            "engineLocked": True,
            "isAutoProfile": True,
            "provider": self.provider,
            "model": self.model,
            "thinkingLevel": self.effort,
            "phaseProviders": dict.fromkeys(ENGINE_PHASES, self.provider),
            "phaseModels": dict.fromkeys(ENGINE_PHASES, self.model),
            "phaseThinking": dict.fromkeys(ENGINE_PHASES, self.effort),
        }


def parse_engines(raw) -> list[Engine]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_VARIANTS:
        raise BenchError(f"give between 1 and {MAX_VARIANTS} engines")
    engines: list[Engine] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise BenchError(f"engine {index} must be an object")
        provider, model, effort = (
            item.get("provider"),
            item.get("model"),
            item.get("effort"),
        )
        if not isinstance(provider, str) or not _PROVIDER.match(provider):
            raise BenchError(f"engine {index} has no valid provider")
        if (
            not isinstance(model, str)
            or not model.strip()
            or len(model) > 200
            or any(ord(c) < 32 for c in model)
        ):
            raise BenchError(f"engine {index} has no valid model")
        if not isinstance(effort, str) or not _EFFORT.match(effort):
            raise BenchError(f"engine {index} has no valid effort")
        engine = Engine(provider, model.strip(), effort)
        if engine in engines:
            raise BenchError(f"engine {index} is listed twice")
        engines.append(engine)
    return engines


def parse_specs(raw, limit: int = MAX_CASES) -> list[str]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= limit:
        raise BenchError(f"give between 1 and {limit} cards")
    specs: list[str] = []
    for spec in raw:
        if not isinstance(spec, str) or not SPEC_ID.match(spec):
            raise BenchError("invalid card id")
        if spec not in specs:
            specs.append(spec)
    return specs


def parse_commits(raw) -> dict[str, str]:
    if raw in (None, ""):
        return {}
    if not isinstance(raw, dict):
        raise BenchError("commits must map a card to a commit")
    out: dict[str, str] = {}
    for spec, sha in raw.items():
        if not isinstance(spec, str) or not SPEC_ID.match(spec):
            raise BenchError("invalid card id")
        if not isinstance(sha, str) or not COMMIT.match(sha.strip().lower()):
            raise BenchError(f"{spec}: a commit is 7 to 64 hexadecimal characters")
        out[spec] = sha.strip().lower()
    return out


def spec_dir(project_dir: Path, spec_id: str) -> Path:
    folder = project_dir / ".workpilot" / "specs" / spec_id
    if folder.is_symlink() or not folder.is_dir():
        raise BenchError(f"{spec_id}: no such card")
    return folder


# --------------------------------------------------------------------------
# 1. discover


def discover_case(project_dir: Path, spec_id: str, given: str | None) -> dict:
    case: dict = {"caseId": spec_id, "status": "refused"}
    try:
        folder = spec_dir(project_dir, spec_id)
    except BenchError as error:
        _refuse(case, "no-card", str(error))
        return case
    target, source, note = None, "", ""
    if given:
        target = repo.resolve_commit(project_dir, given)
        source = "given"
        if target is None:
            _refuse(case, "commit-unknown", f"commit {given} is not in the repository")
            return case
    else:
        target, note = repo.merge_of_branch(project_dir, spec_id)
        source = "merge"
        if target is None:
            metadata = read_json(folder / "task_metadata.json") or {}
            target = repo.merge_of_pr(project_dir, metadata.get("prUrl"))
            source = "pr"
    if target is None:
        _refuse(
            case,
            "no-target",
            "no merge of its branch was found and its pull request gave no "
            "merge commit: give the commit the card landed as",
        )
        return case
    parents = repo.parents(project_dir, target)
    if not parents:
        _refuse(case, "no-parent", "the target commit has no parent")
        return case
    base = parents[0]
    changes = repo.test_changes(project_dir, base, target)
    case.update(
        target=target,
        base=base,
        source=source,
        tests=changes.changed,
        deletedTests=changes.deleted,
        runnable=changes.runnable,
    )
    if note:
        case["note"] = note
    if not changes.runnable:
        _refuse(
            case,
            "no-judge",
            "the card changed no test a runner can run: there is no judge",
        )
        return case
    case["status"] = "candidate"
    return case


def _refuse(case: dict, code: str, text: str, status: str = "refused") -> None:
    """``reasonCode`` is what the app translates; ``reason`` is the detail."""
    case["status"] = status
    case["reasonCode"] = code
    case["reason"] = text


def _skip(build: dict, code: str, text: str) -> None:
    build["state"] = "skipped"
    build["reasonCode"] = code
    build["reason"] = text


def discover(
    project_dir: Path, specs: list[str], commits: dict[str, str]
) -> list[dict]:
    return [discover_case(project_dir, s, commits.get(s)) for s in specs]


# --------------------------------------------------------------------------
# 2. prepare


def _changes(case: dict) -> repo.TestChanges:
    return repo.TestChanges(
        changed=list(case["tests"]), deleted=list(case["deletedTests"])
    )


def calibrate(project_dir: Path, case: dict, root: Path) -> None:
    """Fill ``case`` with its suites and its F2P and P2P tests, or a reason."""
    folder = root / "cases" / case["caseId"]
    logs = root / "logs"
    target_copy = folder / "target"
    base_copy = folder / "base"
    try:
        repo.isolated_copy(project_dir, case["target"], target_copy, depth=1)
        suites = judging.detect_suites(project_dir, target_copy, case["runnable"])
        case["suites"] = [s.to_dict() for s in suites]
        runs = []
        for attempt in (1, 2):
            runs.append(
                judging.run_suites(
                    suites,
                    project_dir,
                    target_copy,
                    folder / f"reports-target-{attempt}",
                    logs / f"{case['caseId']}-target.log",
                )
            )
        passing = {
            test
            for test, result in runs[0].results.items()
            if result == "pass" and runs[1].results.get(test) == "pass"
        }
        if not passing:
            errors = sorted({e for r in runs for e in r.errors})
            _refuse(
                case,
                "never-passes",
                "no test of the card passes at its target commit"
                + (f" ({'; '.join(errors)})" if errors else ""),
                status="excluded",
            )
            return
        repo.isolated_copy(project_dir, case["base"], base_copy, depth=1)
        repo.overlay_tests(project_dir, case["target"], base_copy, _changes(case))
        baseline = judging.run_suites(
            suites,
            project_dir,
            base_copy,
            folder / "reports-base",
            logs / f"{case['caseId']}-base.log",
        )
        f2p = sorted(t for t in passing if baseline.results.get(t) != "pass")
        p2p = sorted(t for t in passing if baseline.results.get(t) == "pass")
        case["f2p"], case["p2p"] = f2p, p2p
        if not f2p:
            _refuse(
                case,
                "already-passes",
                "every test of the card already passes without the card: "
                "they cannot tell its work from its absence",
                status="excluded",
            )
            return
        case["status"] = "ready"
    except BenchError as error:
        _refuse(case, "judge-error", str(error), status="excluded")
    finally:
        suites_seen = [judging.Suite.from_dict(s) for s in case.get("suites") or []]
        for copy in (target_copy, base_copy):
            judging.unlink_dependencies(copy, suites_seen)
        remove_tree(folder)


def copy_spec(
    project_dir: Path, case: dict, engine: Engine, copy_dir: Path, marker: dict
) -> None:
    source = spec_dir(project_dir, case["caseId"])
    dest = copy_dir / ".workpilot" / "specs" / case["caseId"]
    dest.mkdir(parents=True)
    for name in SPEC_FILES:
        file = source / name
        if file.is_file() and not file.is_symlink():
            shutil.copyfile(file, dest / name)
    if not (dest / "spec.md").is_file():
        raise BenchError(f"{case['caseId']}: the card has no spec.md")
    original = read_json(source / "task_metadata.json") or {}
    metadata = {k: original[k] for k in METADATA_KEYS if k in original}
    metadata.update(engine.metadata())
    metadata["requireReviewBeforeCoding"] = False
    metadata["bench"] = marker
    write_json(dest / "task_metadata.json", metadata)


def prepare(
    project_dir: Path,
    specs: list[str],
    engines: list[Engine],
    commits: dict[str, str],
    run_id: str | None = None,
) -> dict:
    run_id = check_run_id(run_id) if run_id else new_run_id()
    path = manifest_path(project_dir, run_id)
    if path.exists():
        raise BenchError("this run already exists")
    root = work_dir(project_dir, run_id)
    manifest = {
        "runId": run_id,
        "createdAt": now(),
        "phase": "calibrating",
        "engines": [
            {
                "id": f"v{i}",
                "provider": e.provider,
                "model": e.model,
                "effort": e.effort,
            }
            for i, e in enumerate(engines, start=1)
        ],
        "cases": discover(project_dir, specs, commits),
        "builds": [],
    }
    write_json(path, manifest)
    for case in manifest["cases"]:
        if case["status"] != "candidate":
            continue
        case["status"] = "calibrating"
        write_json(path, manifest)
        calibrate(project_dir, case, root)
        write_json(path, manifest)

    number = 0
    for case in manifest["cases"]:
        if case["status"] != "ready":
            continue
        for index, engine in enumerate(engines, start=1):
            number += 1
            build_id = f"b{number}"
            copy_dir = root / "builds" / build_id
            build = {
                "id": build_id,
                "caseId": case["caseId"],
                "engineId": f"v{index}",
                "taskId": f"bench-{run_id.lower()}-{build_id}",
                "copy": str(copy_dir),
                "state": "pending",
            }
            try:
                repo.isolated_copy(
                    project_dir, case["base"], copy_dir, depth=VARIANT_DEPTH
                )
                if repo.contains(copy_dir, case["target"]):
                    raise BenchError("the copy holds the target commit")
                copy_spec(
                    project_dir,
                    case,
                    engine,
                    copy_dir,
                    {"runId": run_id, "buildId": build_id, "caseId": case["caseId"]},
                )
            except BenchError as error:
                _skip(build, "copy-failed", str(error))
                remove_tree(copy_dir)
            manifest["builds"].append(build)
    manifest["phase"] = (
        "running"
        if any(b["state"] == "pending" for b in manifest["builds"])
        else "done"
    )
    write_json(path, manifest)
    if manifest["phase"] == "done":
        remove_tree(root / "builds")
    return manifest


# --------------------------------------------------------------------------
# 4. judge


def read_manifest(project_dir: Path, run_id: str) -> dict:
    manifest = read_json(manifest_path(project_dir, run_id))
    if manifest is None or not isinstance(manifest.get("builds"), list):
        raise BenchError("no such run")
    return manifest


def _build(manifest: dict, build_id: str) -> dict:
    if not BUILD_ID.match(build_id or ""):
        raise BenchError("invalid build id")
    for build in manifest["builds"]:
        if build.get("id") == build_id:
            return build
    raise BenchError("no such build in this run")


def _cost(copy_dir: Path, spec_id: str) -> float | None:
    data = read_json(copy_dir / ".workpilot" / "cost_data.json") or {}
    usages = data.get("usages")
    if not isinstance(usages, list):
        return None
    total, seen = 0.0, False
    for usage in usages:
        if isinstance(usage, dict) and usage.get("spec_id") == spec_id:
            cost = usage.get("cost")
            if isinstance(cost, (int, float)) and cost >= 0:
                total += float(cost)
                seen = True
    return total if seen else None


def _duration(started: str | None, ended: str | None) -> float | None:
    try:
        start = datetime.fromisoformat(str(started))
        end = datetime.fromisoformat(str(ended))
    except ValueError:
        return None
    seconds = (end - start).total_seconds()
    return seconds if seconds >= 0 else None


def judge_build(
    project_dir: Path,
    run_id: str,
    build_id: str,
    outcome: str,
    exit_code: int | None = None,
    started_at: str | None = None,
    ended_at: str | None = None,
) -> dict:
    """Judge one ended build. ``outcome`` is ``ended``, ``not-started`` or
    ``interrupted``; only an ended build is judged and counted."""
    if outcome not in ("ended", "not-started", "interrupted"):
        raise BenchError("invalid outcome")
    manifest = read_manifest(project_dir, run_id)
    build = _build(manifest, build_id)
    if build["state"] != "pending":
        raise BenchError(f"{build_id} is already {build['state']}")
    case = next(c for c in manifest["cases"] if c["caseId"] == build["caseId"])
    engine = next(e for e in manifest["engines"] if e["id"] == build["engineId"])
    copy_dir = work_dir(project_dir, run_id) / "builds" / build_id
    build["exitCode"] = exit_code
    build["durationS"] = _duration(started_at, ended_at)
    build["costUsd"] = _cost(copy_dir, case["caseId"])
    if outcome != "ended":
        if outcome == "not-started":
            _skip(build, "not-started", "the build did not start")
        else:
            _skip(build, "interrupted", "the build was interrupted")
    else:
        _judge(project_dir, run_id, case, build, copy_dir)
    if build["state"] == "judged":
        add_records(
            project_dir,
            [
                {
                    "runId": run_id,
                    "buildId": build_id,
                    "caseId": case["caseId"],
                    "provider": engine["provider"],
                    "model": engine["model"],
                    "effort": engine["effort"],
                    "resolved": build["resolved"],
                    "f2pPassed": build["f2pPassed"],
                    "f2pTotal": len(case["f2p"]),
                    "p2pPassed": build["p2pPassed"],
                    "p2pTotal": len(case["p2p"]),
                    "costUsd": build["costUsd"],
                    "durationS": build["durationS"],
                    "judgedAt": now(),
                }
            ],
        )
    if not any(b["state"] == "pending" for b in manifest["builds"]):
        manifest["phase"] = "done"
        manifest["endedAt"] = now()
    write_json(manifest_path(project_dir, run_id), manifest)
    remove_tree(copy_dir)
    if manifest["phase"] == "done":
        # The logs stay, for the person to read why a build did not resolve.
        root = work_dir(project_dir, run_id)
        for folder in ("builds", "cases", "reports"):
            remove_tree(root / folder)
    return manifest


def _judge(
    project_dir: Path, run_id: str, case: dict, build: dict, copy_dir: Path
) -> None:
    root = work_dir(project_dir, run_id)
    try:
        if not copy_dir.is_dir() or copy_dir.is_symlink():
            raise BenchError("the copy is gone")
        if repo.contains(copy_dir, case["target"]):
            _skip(
                build,
                "saw-answer",
                "the copy holds the target commit: the build saw the answer",
            )
            return
        changes = _changes(case)
        build["resetTests"] = repo.reset_agent_tests(copy_dir, case["base"], changes)
        repo.overlay_tests(project_dir, case["target"], copy_dir, changes)
        suites = [judging.Suite.from_dict(s) for s in case["suites"]]
        result = judging.run_suites(
            suites,
            project_dir,
            copy_dir,
            root / "reports" / build["id"],
            root / "logs" / f"{build['id']}.log",
        )
    except (BenchError, OSError) as error:
        _skip(build, "judge-error", f"the judge could not run: {error}")
        return
    finally:
        judging.unlink_dependencies(
            copy_dir, [judging.Suite.from_dict(s) for s in case.get("suites") or []]
        )
    f2p_passed = sum(1 for t in case["f2p"] if result.results.get(t) == "pass")
    p2p_passed = sum(1 for t in case["p2p"] if result.results.get(t) == "pass")
    build["state"] = "judged"
    build["f2pPassed"] = f2p_passed
    build["p2pPassed"] = p2p_passed
    build["resolved"] = f2p_passed == len(case["f2p"]) and p2p_passed == len(
        case["p2p"]
    )
    if result.errors:
        build["judgeErrors"] = result.errors


# --------------------------------------------------------------------------
# discard


def discard(project_dir: Path, run_id: str) -> dict:
    manifest = read_manifest(project_dir, run_id)
    for build in manifest["builds"]:
        if build["state"] == "pending":
            _skip(build, "discarded", "the run was discarded")
    if manifest.get("phase") != "done":
        manifest["phase"] = "discarded"
        manifest["endedAt"] = now()
    write_json(manifest_path(project_dir, run_id), manifest)
    remove_tree(work_dir(project_dir, run_id))
    return manifest


def _make_writable(function, path, _error) -> None:
    # Git writes its objects read-only; Windows refuses to delete them so.
    os.chmod(path, stat.S_IWRITE)
    function(path)


def remove_tree(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
        return
    if not path.exists():
        return
    try:
        shutil.rmtree(path, onexc=_make_writable)
    except TypeError:  # Python before 3.12
        shutil.rmtree(path, onerror=_make_writable)
