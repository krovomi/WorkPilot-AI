"""Mobile Runner — the desktop app's window onto `mobile/`.

Detects the mobile stack, lists the devices this machine actually has, and
reports whether each target platform can be built here. No LLM, no network:
every answer comes from files on disk and from local `adb`/`xcrun` reads, which
is why the Kanban can call it on every task panel open.

Output: ``__MOBILE_RESULT__:{json}`` — the same convention
`app_emulator_runner` uses, so the Electron side parses it with the code it
already has.

    python runners/mobile_runner.py --project-dir . --action detect
    python runners/mobile_runner.py --project-dir . --action devices --platform android
    python runners/mobile_runner.py --project-dir . --action doctor
    python runners/mobile_runner.py --project-dir . --action plan --platform ios
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mobile import detect_stack, doctor, list_devices  # noqa: E402
from mobile.stacks import normalise_targets  # noqa: E402

RESULT_MARKER = "__MOBILE_RESULT__:"


def _detect(project_dir: str) -> dict:
    stack = detect_stack(project_dir)
    if not stack:
        return {
            "success": True,
            "isMobile": False,
            "reason": (
                "No Android, iOS, Flutter, React Native, .NET MAUI, Kotlin "
                "Multiplatform or Capacitor project found under this directory."
            ),
        }
    return {"success": True, "isMobile": True, "stack": stack.to_dict()}


def _devices(platforms: tuple[str, ...]) -> dict:
    listing = list_devices(platforms or None)
    return {"success": True, **listing.to_dict()}


def _doctor(project_dir: str, platforms: tuple[str, ...]) -> dict:
    stack = detect_stack(project_dir)
    reports = doctor(project_dir, platforms=platforms or None, stack=stack)
    return {
        "success": True,
        "isMobile": stack is not None,
        "platforms": {name: report.to_dict() for name, report in reports.items()},
    }


def _plan(project_dir: str, platforms: tuple[str, ...]) -> dict:
    """Everything the preview panel needs in one call.

    Three round-trips to a Python subprocess to fill one panel is three chances
    for the three answers to disagree about which project they describe.
    """
    stack = detect_stack(project_dir)
    if not stack:
        return _detect(project_dir)

    wanted = tuple(p for p in platforms if p in stack.platforms) or stack.platforms
    listing = list_devices(wanted)
    reports = doctor(project_dir, platforms=wanted, stack=stack)
    return {
        "success": True,
        "isMobile": True,
        "stack": stack.to_dict(),
        "platforms": {name: report.to_dict() for name, report in reports.items()},
        **listing.to_dict(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Mobile — detect the stack, the devices and the toolchain"
    )
    parser.add_argument("--project-dir", required=True, help="Path to the project")
    parser.add_argument(
        "--action",
        default="plan",
        choices=("detect", "devices", "doctor", "plan"),
        help="What to answer (default: plan — all three at once)",
    )
    parser.add_argument(
        "--platform",
        action="append",
        default=[],
        help="Narrow to android and/or ios; repeatable. Defaults to what the project targets.",
    )
    args = parser.parse_args()

    project_dir = args.project_dir
    if args.action != "devices" and not os.path.isdir(project_dir):
        print(
            RESULT_MARKER
            + json.dumps(
                {"success": False, "error": f"Directory not found: {project_dir}"}
            )
        )
        return 1

    platforms = normalise_targets(args.platform)
    handlers = {
        "detect": lambda: _detect(project_dir),
        "devices": lambda: _devices(platforms),
        "doctor": lambda: _doctor(project_dir, platforms),
        "plan": lambda: _plan(project_dir, platforms),
    }

    try:
        result = handlers[args.action]()
    except Exception as exc:  # noqa: BLE001 - the caller parses one line, always
        result = {"success": False, "error": str(exc)}

    print(RESULT_MARKER + json.dumps(result))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
