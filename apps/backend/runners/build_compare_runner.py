"""
Build Compare Runner

The desktop backend of "How you compare" in Build Analytics: a project's
specs against its own past and against the person's other projects, all read
from the folders on this machine (``shared_features.build_compare``). Nothing
is sent anywhere.

The main process sends the folders of the projects the person registered in
the app, as one JSON object on stdin, never argv:
    {"current": {"path": "...", "name": "..."},
     "others": [{"path": "...", "name": "..."}, ...]}

Output protocol (one line each, prefixed):
    BUILD_COMPARE_RESULT:{...}
    BUILD_COMPARE_ERROR:<message>
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from shared_features import build_compare  # noqa: E402

#: The person's other projects read, at most; and a project name's length.
MAX_OTHERS = 50
NAME_MAX = 120
#: On the desktop every project compared is the person's own: a median of two
#: of them already says something, and none stands for someone else's work.
LOCAL_MIN_GROUP = 2


def _error(message: str) -> None:
    print(f"BUILD_COMPARE_ERROR:{' '.join(message.split())}", flush=True)


def _project(raw: object) -> tuple[Path, str]:
    """A project folder and its name; ValueError for anything else."""
    if not isinstance(raw, dict):
        raise ValueError("A project must be an object")
    path, name = raw.get("path"), raw.get("name")
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("A project path is required")
    folder = Path(path)
    if not folder.is_absolute() or not folder.is_dir():
        raise ValueError("A project path must be an existing absolute folder")
    label = name.strip()[:NAME_MAX] if isinstance(name, str) else ""
    return folder.resolve(), label or folder.name


def handle(request: dict[str, Any], now: datetime) -> dict[str, Any]:
    current_path, current_name = _project(request.get("current"))
    others = request.get("others")
    if not isinstance(others, list):
        raise ValueError("The other projects must be a list")
    peers: list[tuple[Path, str]] = []
    for raw in others[:MAX_OTHERS]:
        try:
            path, name = _project(raw)
        except ValueError:
            # A project whose folder was moved or removed is left out.
            continue
        if path != current_path and path not in {p for p, _n in peers}:
            peers.append((path, name))

    current = build_compare.project_facts(current_path)
    facts = [(name, build_compare.project_facts(path)) for path, name in peers]
    result = build_compare.compare(
        current, [f for _n, f in facts], now, min_group=LOCAL_MIN_GROUP
    )
    lines = [build_compare.peer_line(name, f, now) for name, f in facts]
    result["projects"] = [
        {**build_compare.peer_line(current_name, current, now), "current": True},
        *({**line, "current": False} for line in lines if line["specs"]),
    ]
    return result


def main() -> None:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        if not isinstance(request, dict):
            raise ValueError("The request must be a JSON object")
        result = handle(request, datetime.now(UTC))
    except (ValueError, OSError, RecursionError) as exc:
        _error(str(exc))
        sys.exit(1)
    print(f"BUILD_COMPARE_RESULT:{json.dumps(result)}", flush=True)


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    main()
