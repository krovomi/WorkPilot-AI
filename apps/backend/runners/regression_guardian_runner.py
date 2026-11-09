"""
Regression Guardian Runner

Discovers APM incident payloads under ``<project>/.workpilot/incidents/*.json``
and runs them through the Regression Guardian pipeline (parse → dedup →
generate → fixtures). Returns a list of results ready for the frontend
dashboard.

Output protocol (one JSON object per line, prefixed):
    REGRESSION_GUARDIAN_EVENT:{"type": "progress", "data": {"status": "..."}}
    REGRESSION_GUARDIAN_RESULT:{"results": [...]}
    REGRESSION_GUARDIAN_ERROR:<message>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from regression_guardian import (  # noqa: E402
    DedupChecker,
    Incident,
    PipelineResult,
    WebhookHandler,
)
from regression_guardian.stacks import detect_framework  # noqa: E402

INCIDENTS_SUBDIR = Path(".workpilot") / "incidents"


def _emit(prefix: str, payload: Any) -> None:
    print(f"{prefix}:{json.dumps(payload, default=str)}", flush=True)


def _emit_event(event_type: str, data: dict[str, Any]) -> None:
    _emit("REGRESSION_GUARDIAN_EVENT", {"type": event_type, "data": data})


def _incident_to_dict(incident: Incident) -> dict[str, Any]:
    return {
        "id": incident.id,
        "source": incident.source.value,
        "title": incident.title,
        "severity": incident.severity.value,
        "exceptionType": incident.exception_type,
        "exceptionMessage": incident.exception_message,
        "stackFrames": [
            {
                "file": f.file,
                "function": f.function,
                "line": f.line,
                "column": f.column,
                "context": f.context,
            }
            for f in incident.stack_frames
        ],
        "service": incident.service,
        "environment": incident.environment,
        "faultingFile": incident.faulting_file,
        "faultingFunction": incident.faulting_function,
    }


def _pipeline_result_to_dict(result: PipelineResult) -> dict[str, Any] | None:
    if result.incident is None:
        return None

    generated_test = None
    if result.test is not None:
        generated_test = {
            "incidentId": result.test.incident_id,
            "framework": result.test.framework.value,
            "filePath": result.test.file_path,
            "code": result.test.test_code,
            "isDuplicate": False,
        }

    is_duplicate = bool(result.dedup and result.dedup.is_duplicate)
    duplicate_path = (
        result.dedup.similar_test_path
        if result.dedup and result.dedup.is_duplicate
        else ""
    )
    fixture_data: dict[str, Any] = {}
    if result.fixtures:
        for fix in result.fixtures:
            if hasattr(fix, "name") and hasattr(fix, "data"):
                fixture_data[fix.name] = fix.data

    return {
        "incident": _incident_to_dict(result.incident),
        "generatedTest": generated_test,
        "isDuplicate": is_duplicate,
        "duplicatePath": duplicate_path or "",
        "fixtureData": fixture_data,
    }


def _discover_incidents(project_path: Path) -> list[Path]:
    incidents_dir = project_path / INCIDENTS_SUBDIR
    if not incidents_dir.exists():
        return []
    return sorted(p for p in incidents_dir.glob("*.json") if p.is_file())


def run_scan(project_path: Path) -> dict[str, Any]:
    _emit_event("start", {"status": "Discovering incident payloads..."})
    incident_files = _discover_incidents(project_path)

    if not incident_files:
        _emit_event(
            "complete",
            {"status": "No incidents found", "results": 0},
        )
        return {"results": []}

    _emit_event(
        "progress",
        {"status": f"Processing {len(incident_files)} incident(s)..."},
    )

    # Each incident gets the framework of the stack its faulting file is in.
    handler = WebhookHandler(
        dedup_checker=DedupChecker(),
        framework_for=lambda incident: detect_framework(
            project_path, incident.faulting_file
        ),
    )
    results: list[dict[str, Any]] = []
    for file_path in incident_files:
        try:
            payload = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            _emit_event("progress", {"status": f"Skipped {file_path.name}: {exc}"})
            continue

        pipeline_result = handler.handle(payload)
        converted = _pipeline_result_to_dict(pipeline_result)
        if converted is not None:
            results.append(converted)

    _emit_event("complete", {"results": len(results)})
    return {"results": results}


FEED_PREFIX = "REGRESSION_GUARDIAN_FEED"
FEED_ERROR_PREFIX = "REGRESSION_GUARDIAN_FEED_ERROR"
SENTRY_TIMEOUT = 20.0
MAX_SENTRY_ANSWER = 2 * 1024 * 1024


def _sentry_client(token: str):
    """GET on Sentry with the token in a header, redirects not followed."""
    import httpx
    from regression_guardian.feed import FeedError

    headers = {"Authorization": f"Bearer {token}", "User-Agent": "WorkPilot-AI"}

    async def get(url: str, params: dict[str, str] | None) -> Any:
        try:
            async with httpx.AsyncClient(
                timeout=SENTRY_TIMEOUT, follow_redirects=False
            ) as client:
                answer = await client.get(url, headers=headers, params=params)
        except httpx.HTTPError:
            raise FeedError("source_failed", "Sentry unreachable") from None
        if not 200 <= answer.status_code < 300:
            raise FeedError("source_failed", f"Sentry answered {answer.status_code}")
        if len(answer.content) > MAX_SENTRY_ANSWER:
            raise FeedError("source_failed", "Sentry's answer is too large")
        try:
            return answer.json()
        except ValueError:
            raise FeedError(
                "source_failed", "Sentry answered something else than JSON"
            ) from None

    return get


async def run_feed(
    project_path: Path, since: str, trigger: dict[str, Any], seen_keys: set[str]
) -> dict[str, Any]:
    """The automation rule's events: the inbox, then Sentry when named.

    The Sentry token comes from ``SENTRY_AUTH_TOKEN`` in this process's
    environment, which the main process builds from the project's ``.env``
    files; it never comes on the command line.
    """
    import os
    from datetime import datetime

    from regression_guardian.feed import (
        FeedError,
        inbox_events,
        parse_sentry_target,
        sentry_events,
    )

    moment = datetime.fromisoformat(since.replace("Z", "+00:00"))

    def seen(key: str) -> bool:
        return key in seen_keys

    feeds = [inbox_events(project_path, moment.timestamp(), seen)]
    target = parse_sentry_target(trigger)
    if target is not None:
        from offline_policy import guard_cloud_client

        token = os.environ.get("SENTRY_AUTH_TOKEN", "").strip()
        if not token:
            raise FeedError(
                "sentry_token_missing",
                "SENTRY_AUTH_TOKEN is not set in the project's .env",
            )
        try:
            guard_cloud_client(project_path)
        except ValueError as e:
            raise FeedError("source_failed", str(e)) from None
        stamp = moment.isoformat().replace("+00:00", "Z")
        feeds.append(
            await sentry_events(
                _sentry_client(token), target, stamp, seen, project_path
            )
        )
    return {
        "events": [
            {
                "key": e.key,
                "subject": e.subject,
                "title": e.title,
                "description": e.description,
                **({"url": e.url} if e.url else {}),
            }
            for feed in feeds
            for e in feed.events
        ],
        "ignored": [
            {"key": key, "subject": subject, "reason": reason}
            for feed in feeds
            for key, subject, reason in feed.ignored
        ],
    }


def _feed_main(args: argparse.Namespace, project_path: Path) -> None:
    """``--feed``: the rule's trigger and the keys already seen on stdin."""
    import asyncio

    from regression_guardian.feed import FeedError

    try:
        request = json.loads(sys.stdin.read() or "{}")
        trigger = request.get("trigger") if isinstance(request, dict) else None
        seen = request.get("seen") if isinstance(request, dict) else None
        if not isinstance(trigger, dict) or not isinstance(seen, list):
            raise ValueError("The feed request needs a trigger and the seen keys")
        result = asyncio.run(
            run_feed(
                project_path,
                args.since,
                trigger,
                {k for k in seen if isinstance(k, str)},
            )
        )
    except FeedError as e:
        _emit(FEED_ERROR_PREFIX, {"reason": e.reason, "message": str(e)})
        sys.exit(1)
    except ValueError as e:
        _emit(FEED_ERROR_PREFIX, {"reason": "source_failed", "message": str(e)})
        sys.exit(1)
    _emit(FEED_PREFIX, result)


def main() -> None:
    parser = argparse.ArgumentParser(description="Regression Guardian Runner")
    parser.add_argument("--project-path", required=True, help="Project root path")
    parser.add_argument(
        "--feed",
        action="store_true",
        help="Read the automation rule's incidents (inbox, Sentry) as events",
    )
    parser.add_argument("--since", default="", help="The rule's creation time, ISO")
    args = parser.parse_args()

    project_path = Path(args.project_path)
    if not project_path.exists():
        _emit(
            "REGRESSION_GUARDIAN_ERROR",
            f"Project path does not exist: {project_path}",
        )
        sys.exit(1)

    if args.feed:
        _feed_main(args, project_path)
        return

    try:
        result = run_scan(project_path)
        _emit("REGRESSION_GUARDIAN_RESULT", result)
    except Exception as exc:  # noqa: BLE001
        _emit("REGRESSION_GUARDIAN_ERROR", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
