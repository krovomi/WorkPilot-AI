"""
Usage Tracker — Records LLM token usage and costs from agent sessions.

Writes to four destinations:
  1. {root}/.workpilot/cost_data.json          (Costs view, goal spend, coach)
  2. analytics.db SQLite                         (AnalyticsDashboard REST API)
  3. {root}/.workpilot/dashboard_snapshot.json (QA and merge counters, build times)
  4. {root}/.workpilot/carbon-ledger.json      (CarbonProfiler)

``root`` is the project, never a task's worktree: a build runs in
``<root>/.workpilot/worktrees/tasks/<spec>/`` and the ``project_dir`` it hands
over is that worktree, whose ``.workpilot`` the dashboard never read and the
merge deletes. ``ledger_root`` walks back to the project, so every task of a
project feeds one ledger (``foundation.json_ledger`` serialises the processes).

Called from agents/session.py after each run_agent_session() call.
All writes are best-effort: errors are logged but never propagated to the caller.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

from foundation.json_ledger import update_json

COST_DATA = "cost_data.json"
SNAPSHOT = "dashboard_snapshot.json"
CARBON_LEDGER = "carbon-ledger.json"


def ledger_root(project_dir: Path) -> Path:
    """The project that owns the usage ledgers of ``project_dir``.

    A build works in ``<root>/.workpilot/worktrees/tasks/<spec>`` (or, for an
    older checkout, ``<root>/.worktrees/<spec>``): its ledgers belong to
    ``<root>``, which the dashboard, the Costs view and the server read, and
    which outlives the worktree. Any other directory is its own root.
    """
    parts = project_dir.parts
    for i, part in enumerate(parts):
        if i == 0:
            continue
        nxt = parts[i + 1] if i + 1 < len(parts) else None
        if part == ".workpilot" and nxt == "worktrees":
            return Path(*parts[:i])
        if part == ".worktrees" and nxt is not None:
            return Path(*parts[:i])
    return project_dir


def _ledger_path(project_dir: Path, name: str) -> Path:
    return ledger_root(project_dir) / ".workpilot" / name


# ---------------------------------------------------------------------------
# In-process build registry  (one entry per active spec_dir)
# ---------------------------------------------------------------------------

_active_builds: dict[str, dict] = {}  # str(spec_dir) -> build_info


def start_build(
    spec_dir: Path,
    project_dir: Path,
    spec_id: str,
    spec_name: str | None,
    model: str,
    provider: str,
) -> str:
    """Register a new build session. Returns a build_id UUID."""
    build_id = str(uuid.uuid4())
    _active_builds[str(spec_dir)] = {
        "build_id": build_id,
        "spec_id": spec_id,
        "spec_name": spec_name or spec_id,
        "project_dir": str(project_dir),
        "model": model,
        "provider": provider,
        "started_at": datetime.now(UTC).isoformat(),
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cache_creation_tokens": 0,
        "total_cache_read_tokens": 0,
        "total_cost": 0.0,
    }
    logger.debug("[usage_tracker] Build started: %s (%s)", build_id, spec_id)
    return build_id


def finish_build(spec_dir: Path, status: str = "complete") -> dict | None:
    """Finalize the build record and write it to analytics DB.

    Returns the record (``started_at``, ``completed_at``, totals), or None when
    no build was registered for ``spec_dir`` in this process.
    """
    key = str(spec_dir)
    info = _active_builds.pop(key, None)
    if not info:
        return None

    info["completed_at"] = datetime.now(UTC).isoformat()
    info["status"] = status

    # Persist to analytics DB
    try:
        _write_build_to_analytics_db(info)
    except Exception as exc:
        logger.warning("[usage_tracker] Could not write build to analytics DB: %s", exc)

    logger.debug("[usage_tracker] Build finished: %s (%s)", info["build_id"], status)
    return info


def build_seconds(info: dict | None) -> float:
    """How long a finished build ran, from ``finish_build``'s record; 0 if unknown."""
    if not info:
        return 0.0
    try:
        started = datetime.fromisoformat(str(info["started_at"]))
        completed = datetime.fromisoformat(str(info["completed_at"]))
    except (KeyError, TypeError, ValueError):
        return 0.0
    return max(0.0, (completed - started).total_seconds())


def spec_complexity(spec_dir: Path) -> str:
    """The complexity the spec pipeline assessed (``complexity_assessment.json``)."""
    try:
        data = json.loads(
            (spec_dir / "complexity_assessment.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return "standard"
    value = data.get("complexity") if isinstance(data, dict) else None
    return (
        value.strip().lower()
        if isinstance(value, str) and value.strip()
        else "standard"
    )


def catalog_cost(
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> float:
    """What a session cost at the catalog's prices; 0.0 when none is known."""
    from harness.application.budget import prices_for
    from harness.domain.cost import call_cost
    from harness.domain.usage import CallUsage

    prices = prices_for(provider, model)
    if prices is None:
        return 0.0
    usage = CallUsage(
        prompt=input_tokens + cache_creation_input_tokens + cache_read_input_tokens,
        cache_read=cache_read_input_tokens,
        cache_write=cache_creation_input_tokens,
        output=output_tokens,
    )
    return call_cost(usage, prices) or 0.0


def record_session_usage(
    spec_dir: Path,
    project_dir: Path,
    phase: str,
    agent_type: str,
    model: str,
    provider: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    usage_source: str = "reported",
) -> None:
    """
    Record usage from one agent session. All writes are best-effort.

    Args:
        spec_dir:                     Spec directory (.workpilot/specs/001-name/)
        project_dir:                  Project root directory
        phase:                        Phase name ("planning", "coding", "qa_review", etc.)
        agent_type:                   Agent type ("planner", "coder", "qa_reviewer", etc.)
        model:                        Model name used (e.g. "claude-sonnet-4-6")
        provider:                     Provider name (e.g. "anthropic")
        input_tokens:                 Non-cached input tokens billed at full rate
        output_tokens:                Output tokens consumed
        cost_usd:                     Total cost in USD (SDK estimate)
        cache_creation_input_tokens:  Tokens written to a new cache entry (premium rate)
        cache_read_input_tokens:      Tokens read from an existing cache entry (reduced rate)
        usage_source:                 "reported" by the provider, or "estimated" from the
                                      response's characters when it reported nothing
    """
    spec_id = spec_dir.name
    if not cost_usd and (input_tokens or output_tokens):
        # Only the Claude SDK and a few loops report a price: the others are
        # priced from the catalog, like the session budget measures them.
        cost_usd = catalog_cost(
            provider,
            model,
            input_tokens,
            output_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        )

    # Update in-process build totals
    key = str(spec_dir)
    if key in _active_builds:
        _active_builds[key]["total_input_tokens"] += input_tokens
        _active_builds[key]["total_output_tokens"] += output_tokens
        _active_builds[key]["total_cache_creation_tokens"] = (
            _active_builds[key].get("total_cache_creation_tokens", 0)
            + cache_creation_input_tokens
        )
        _active_builds[key]["total_cache_read_tokens"] = (
            _active_builds[key].get("total_cache_read_tokens", 0)
            + cache_read_input_tokens
        )
        _active_builds[key]["total_cost"] += cost_usd

    # 1 — cost_data.json (for CostEstimator IPC handler)
    try:
        _append_cost_data(
            project_dir,
            spec_id,
            provider,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
            agent_type,
            phase,
            cache_creation_input_tokens,
            cache_read_input_tokens,
            usage_source,
        )
    except Exception as exc:
        logger.warning("[usage_tracker] cost_data.json write failed: %s", exc)

    # 2 — analytics.db (for AnalyticsDashboard REST API)
    try:
        _append_token_usage_to_db(
            key,
            spec_id,
            provider,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
            phase,
        )
    except Exception as exc:
        logger.warning("[usage_tracker] analytics DB write failed: %s", exc)

    # 3 — dashboard_snapshot.json (for DashboardMetrics REST API)
    try:
        _update_dashboard_snapshot(
            project_dir,
            spec_id,
            provider,
            model,
            input_tokens,
            output_tokens,
            cost_usd,
            cache_creation_input_tokens,
            cache_read_input_tokens,
        )
    except Exception as exc:
        logger.warning("[usage_tracker] dashboard_snapshot write failed: %s", exc)

    # 4 — carbon-ledger.json (for CarbonProfiler runner)
    try:
        _append_carbon_ledger(
            project_dir,
            provider,
            model,
            input_tokens,
            output_tokens,
            cache_creation_input_tokens,
            cache_read_input_tokens,
            spec_id,
            phase,
            agent_type,
        )
    except Exception as exc:
        logger.warning("[usage_tracker] carbon-ledger write failed: %s", exc)


# ---------------------------------------------------------------------------
# Destination 1: cost_data.json
# ---------------------------------------------------------------------------


def _append_cost_data(
    project_dir: Path,
    spec_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    agent_type: str,
    phase: str,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    usage_source: str = "reported",
) -> None:
    """Append a usage record to the project's ``.workpilot/cost_data.json``."""
    root = ledger_root(project_dir)
    record = {
        "project_id": str(root),
        "provider": provider,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_creation_input_tokens": cache_creation_input_tokens,
        "cache_read_input_tokens": cache_read_input_tokens,
        "cost": cost_usd,
        "task_id": spec_id,
        "agent_type": agent_type,
        "phase": phase,
        "spec_id": spec_id,
        "usage_source": usage_source,
        "timestamp": datetime.now(UTC).isoformat(),
    }

    def change(data: object) -> dict:
        if not isinstance(data, dict):
            data = {"usages": [], "budgets": {}}
        if not isinstance(data.get("usages"), list):
            data["usages"] = []
        data["usages"].append(record)
        return data

    update_json(
        root / ".workpilot" / COST_DATA, lambda: {"usages": [], "budgets": {}}, change
    )


# ---------------------------------------------------------------------------
# Destination 2: analytics.db  (SQLite via SQLAlchemy)
# ---------------------------------------------------------------------------


def _get_analytics_db_session():
    """Return an analytics DB session, or None if unavailable."""
    try:
        from analytics.database import SessionLocal, create_tables

        create_tables()
        return SessionLocal()
    except Exception:
        return None


def _append_token_usage_to_db(
    build_key: str,
    spec_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    phase: str,
) -> None:
    """Append a TokenUsage row to analytics.db.
    Also creates/updates the parent Build row if the build is known."""
    db = _get_analytics_db_session()
    if db is None:
        return

    try:
        from analytics.database_schema import Build, BuildStatus, TokenUsage

        build_info = _active_builds.get(build_key)
        build_id = build_info["build_id"] if build_info else str(uuid.uuid4())

        # Upsert Build row
        build = db.query(Build).filter(Build.build_id == build_id).first()
        if not build:
            build = Build(
                build_id=build_id,
                spec_id=spec_id,
                spec_name=build_info.get("spec_name", spec_id)
                if build_info
                else spec_id,
                project_path=build_info.get("project_dir") if build_info else None,
                started_at=datetime.now(UTC),
                status=BuildStatus.CODING,
                llm_provider=provider,
                llm_model=model,
                total_tokens_used=0,
                total_cost_usd=0.0,
            )
            db.add(build)

        build.total_tokens_used = (
            (build.total_tokens_used or 0) + input_tokens + output_tokens
        )
        build.total_cost_usd = (build.total_cost_usd or 0.0) + cost_usd

        # Insert TokenUsage row
        token_row = TokenUsage(
            build_id=build_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            cost_usd=cost_usd,
            operation_type=phase,
            llm_provider=provider,
            llm_model=model,
            timestamp=datetime.now(UTC),
        )
        db.add(token_row)
        db.commit()

    except Exception as exc:
        db.rollback()
        raise exc
    finally:
        db.close()


def _write_build_to_analytics_db(info: dict) -> None:
    """Finalize a Build row in analytics.db when the build ends."""
    db = _get_analytics_db_session()
    if db is None:
        return

    try:
        from analytics.database_schema import Build, BuildStatus

        build = db.query(Build).filter(Build.build_id == info["build_id"]).first()
        if build:
            build.completed_at = datetime.now(UTC)
            build.status = (
                BuildStatus.COMPLETE
                if info["status"] == "complete"
                else BuildStatus.FAILED
            )
            if build.started_at:
                build.total_duration_seconds = (
                    datetime.now(UTC).replace(tzinfo=None)
                    - build.started_at.replace(tzinfo=None)
                ).total_seconds()
            db.commit()
    except Exception as exc:
        db.rollback()
        raise exc
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Destination 3: dashboard_snapshot.json
# ---------------------------------------------------------------------------


def _update_dashboard_snapshot(
    project_dir: Path,
    spec_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> None:
    """Update the project's ``.workpilot/dashboard_snapshot.json``.
    Accumulates token/cost totals and per-provider/model breakdowns."""

    def change(snap: object) -> dict:
        snap = _snapshot(snap)
        total = input_tokens + output_tokens
        snap["total_tokens"] = (snap.get("total_tokens") or 0) + total
        snap["total_cost"] = (snap.get("total_cost") or 0.0) + cost_usd
        snap["total_cache_creation_tokens"] = (
            snap.get("total_cache_creation_tokens") or 0
        ) + cache_creation_input_tokens
        snap["total_cache_read_tokens"] = (
            snap.get("total_cache_read_tokens") or 0
        ) + cache_read_input_tokens
        snap["tokens_by_provider"][provider] = (
            snap["tokens_by_provider"].get(provider, 0) + total
        )
        model_key = f"{provider}/{model}"
        snap["cost_by_model"][model_key] = (
            snap["cost_by_model"].get(model_key) or 0.0
        ) + cost_usd
        snap["last_updated"] = datetime.now(UTC).isoformat()
        return snap

    update_json(_ledger_path(project_dir, SNAPSHOT), dict, change)


def _snapshot(value: object) -> dict:
    """A snapshot with every field the readers expect, whatever was on disk."""
    snap = value if isinstance(value, dict) else {}
    for key, default in (
        ("total_tokens", 0),
        ("total_cost", 0.0),
        ("total_cache_creation_tokens", 0),
        ("total_cache_read_tokens", 0),
        ("qa_first_pass_rate", 0.0),
        ("qa_avg_score", 0.0),
        ("merge_auto_count", 0),
        ("merge_manual_count", 0),
    ):
        snap.setdefault(key, default)
    for key in (
        "tokens_by_provider",
        "cost_by_model",
        "tasks_by_status",
        "avg_completion_by_complexity",
    ):
        if not isinstance(snap.get(key), dict):
            snap[key] = {}
    return snap


# ---------------------------------------------------------------------------
# Destination 4: carbon-ledger.json  (read by carbon_profiler.ledger)
# ---------------------------------------------------------------------------

# Providers whose inference runs on local/consumer hardware rather than a
# hyperscale data centre. The ledger's ``source`` tells the carbon estimate to
# use the machine's power and grid instead of a data centre's.
_LOCAL_PROVIDERS = {"ollama", "local", "lmstudio", "llamacpp", "llama.cpp"}


def _classify_carbon_source(provider: str) -> str:
    """Map a provider name to a ledger ``source`` value."""
    return "llm_local" if (provider or "").lower() in _LOCAL_PROVIDERS else "llm_cloud"


def _resolve_carbon_ledger_root(project_dir: Path) -> Path:
    """The project root that owns the carbon ledger (see ``ledger_root``)."""
    return ledger_root(project_dir)


def _carbon_record(
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_creation_input_tokens: int,
    cache_read_input_tokens: int,
    timestamp: str,
    task: str = "",
    phase: str = "",
    agent: str = "",
) -> dict:
    """Build one carbon-ledger entry in the shape ``carbon_profiler.ledger`` reads.

    ``tokens_in`` counts every input-side token (fresh, cache creation, cache
    read), and ``cache_read`` says how many of them came from the cache, which
    costs far less compute. Task, phase and agent let the report break the
    footprint down.
    """
    return {
        "source": _classify_carbon_source(provider),
        "provider": provider,
        "model": model,
        "tokens_in": int(input_tokens)
        + int(cache_creation_input_tokens)
        + int(cache_read_input_tokens),
        "tokens_out": int(output_tokens),
        "cache_read": int(cache_read_input_tokens),
        "task": task,
        "phase": phase,
        "agent": agent,
        "timestamp": timestamp,
    }


def _append_carbon_ledger(
    project_dir: Path,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    task: str = "",
    phase: str = "",
    agent: str = "",
) -> None:
    """Append one usage record to ``<root>/.workpilot/carbon-ledger.json``.

    The ledger is a flat JSON array (see carbon_profiler/ledger.py).
    """
    entry = _carbon_record(
        provider,
        model,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        datetime.now(UTC).isoformat(),
        task,
        phase,
        agent,
    )

    def change(ledger: object) -> list:
        ledger = ledger if isinstance(ledger, list) else []
        ledger.append(entry)
        return ledger

    update_json(_ledger_path(project_dir, CARBON_LEDGER), list, change)


def backfill_carbon_ledger_from_cost_data(project_dir: Path) -> int:
    """Rebuild ``carbon-ledger.json`` from every ``cost_data.json`` in the project.

    Seeds the ledger for projects whose builds ran before the carbon producer
    existed. Scans the project root plus all worktrees, de-duplicates records,
    and overwrites the ledger. Idempotent: cost_data.json is the superset of all
    tracked usage, so re-running always reproduces the full, correct ledger.

    Returns the number of records written.
    """
    root = _resolve_carbon_ledger_root(project_dir)
    workpilot = root / ".workpilot"

    cost_files: list[Path] = []
    root_cost = workpilot / "cost_data.json"
    if root_cost.exists():
        cost_files.append(root_cost)
    cost_files.extend(sorted(workpilot.glob("worktrees/**/cost_data.json")))

    records: list[dict] = []
    seen: set[tuple] = set()
    for cost_file in cost_files:
        try:
            data = json.loads(cost_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        for usage in data.get("usages", []):
            provider = usage.get("provider", "")
            input_tokens = int(usage.get("input_tokens", 0))
            output_tokens = int(usage.get("output_tokens", 0))
            cache_creation = int(usage.get("cache_creation_input_tokens", 0))
            cache_read = int(usage.get("cache_read_input_tokens", 0))
            timestamp = usage.get("timestamp", "")
            key = (
                timestamp,
                usage.get("task_id"),
                usage.get("phase"),
                input_tokens,
                output_tokens,
            )
            if key in seen:
                continue
            seen.add(key)
            records.append(
                _carbon_record(
                    provider,
                    usage.get("model", ""),
                    input_tokens,
                    output_tokens,
                    cache_creation,
                    cache_read,
                    timestamp,
                    str(usage.get("task_id") or ""),
                    str(usage.get("phase") or ""),
                    str(usage.get("agent_type") or ""),
                )
            )

    update_json(workpilot / CARBON_LEDGER, list, lambda _old: records)
    return len(records)


# ---------------------------------------------------------------------------
# Dashboard snapshot: task/QA/merge helpers (called from run.py / qa runners)
# ---------------------------------------------------------------------------


def record_task_status(
    project_dir: Path,
    spec_id: str,
    status: str,
    complexity: str = "medium",
    completion_seconds: float = 0.0,
) -> None:
    """Count a build's outcome and, when it completed, how long it took.

    The dashboard counts the tasks from the board itself; ``tasks_by_status``
    stays for readers of older snapshots. The durations, by complexity, are
    what the dashboard's "average time" reads.
    """

    def change(snap: object) -> dict:
        snap = _snapshot(snap)
        snap["tasks_by_status"][status] = snap["tasks_by_status"].get(status, 0) + 1
        if status == "completed" and completion_seconds > 0:
            existing = snap["avg_completion_by_complexity"].get(complexity)
            durations = existing if isinstance(existing, list) else []
            durations.append(round(completion_seconds, 1))
            snap["avg_completion_by_complexity"][complexity] = durations
        snap["last_updated"] = datetime.now(UTC).isoformat()
        return snap

    try:
        update_json(_ledger_path(project_dir, SNAPSHOT), dict, change)
    except (OSError, ValueError) as exc:
        logger.warning("[usage_tracker] record_task_status failed: %s", exc)


def record_build_end(
    project_dir: Path, spec_dir: Path, build_status: str, task_status: str
) -> None:
    """Close the build's record and count its outcome. Never raises.

    A completed build reports how long it ran and the spec's complexity, which
    the dashboard's "average time by complexity" reads.
    """
    try:
        build = finish_build(spec_dir, status=build_status)
        record_task_status(
            project_dir,
            spec_dir.name,
            task_status,
            complexity=spec_complexity(spec_dir),
            completion_seconds=build_seconds(build),
        )
    except Exception as exc:  # noqa: BLE001 - telemetry never stops a build
        logger.debug("[usage_tracker] build end not recorded: %s", exc)


def record_qa_result(
    project_dir: Path,
    spec_id: str,
    passed: bool,
    score: float = 0.0,
) -> None:
    """Update QA first-pass rate in dashboard_snapshot.json (running average)."""

    def change(snap: object) -> dict:
        snap = _snapshot(snap)
        snap["_qa_total"] = (snap.get("_qa_total") or 0) + 1
        snap["_qa_passed"] = (snap.get("_qa_passed") or 0) + (1 if passed else 0)
        snap["_qa_score_sum"] = (snap.get("_qa_score_sum") or 0.0) + score
        snap["qa_first_pass_rate"] = snap["_qa_passed"] / snap["_qa_total"] * 100
        snap["qa_avg_score"] = snap["_qa_score_sum"] / snap["_qa_total"]
        snap["last_updated"] = datetime.now(UTC).isoformat()
        return snap

    try:
        update_json(_ledger_path(project_dir, SNAPSHOT), dict, change)
    except (OSError, ValueError) as exc:
        logger.warning("[usage_tracker] record_qa_result failed: %s", exc)


def record_merge(project_dir: Path, automatic: bool) -> None:
    """Increment merge counters in dashboard_snapshot.json."""

    def change(snap: object) -> dict:
        snap = _snapshot(snap)
        key = "merge_auto_count" if automatic else "merge_manual_count"
        snap[key] = (snap.get(key) or 0) + 1
        snap["last_updated"] = datetime.now(UTC).isoformat()
        return snap

    try:
        update_json(_ledger_path(project_dir, SNAPSHOT), dict, change)
    except (OSError, ValueError) as exc:
        logger.warning("[usage_tracker] record_merge failed: %s", exc)


def on_merge(event) -> None:
    """`core.merge_event` subscriber: count the merge for the dashboard."""
    record_merge(event.project_dir, automatic=event.automatic)
