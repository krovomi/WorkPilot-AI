#!/usr/bin/env python3
"""Put a phone application on a real device, and say what happened.

Two callers, one script:

* **`mobile-device-check.yml`**, on a GitHub runner with a booted emulator. It
  is the only thing in this repository that proves the commands
  `mobile/stacks.py` computes are commands Gradle actually accepts, and that a
  frame can be captured off a device at all.
* **a developer**, against their own project and their own emulator:

      python scripts/mobile_device_check.py --project-dir ../my-app
      python scripts/mobile_device_check.py --project-dir ../my-app --launch

Without `--launch` it only reads: the stack, the devices, the toolchain
verdict. That is the useful 90% and it costs nothing — no build, no install,
no device required. `--launch` is the other 10%: build, install, start the
activity, capture a frame.

It deliberately runs **the commands the product computed**, never commands
written here. A copy of the build command in this file would pass while the
product's own was wrong, which is the failure this is meant to catch.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from mobile import detect_stack, list_devices  # noqa: E402
from mobile.launch import build_and_run, capture_frame, launch_app  # noqa: E402
from mobile.launch import (
    is_png as _is_png,  # noqa: E402,F401 - the frame check, kept by name
)
from mobile.readiness import doctor  # noqa: E402
from mobile.stacks import ANDROID, IOS, MobilePlatform  # noqa: E402


def say(label: str, value: str = "") -> None:
    print(f"{label:<22}{value}" if value else label, flush=True)


def report_plan(project_dir: Path, platform: MobilePlatform | None) -> tuple:
    """The read-only half: stack, toolchain, devices."""
    stack = detect_stack(project_dir)
    say("project", str(project_dir))
    if not stack:
        say("stack", "not a mobile project")
        return None, None, []

    say("stack", f"{stack.framework}  [{', '.join(stack.platforms)}]")
    if stack.package_id:
        say("package id", stack.package_id)
    say("mobile root", stack.project_dir)

    wanted = (platform,) if platform else stack.platforms
    print()
    for name, report in doctor(project_dir, platforms=wanted, stack=stack).items():
        say(f"{name} buildable", "yes" if report.ok else f"NO — {report.blocker}")
        for check in report.checks:
            mark = "ok " if check.ok else ("MISSING" if check.required else "absent ")
            say(f"  {mark} {check.tool}", check.detail)
            if check.remedy:
                say("       →", check.remedy)

    print()
    listing = list_devices(wanted)
    for reason in (listing.unavailable or {}).values():
        say("no devices", reason)
    for device in listing.devices:
        state = "booted" if device.is_booted else device.state
        say(f"  {device.platform} device", f"{device.name}  [{device.id}]  {state}")

    return stack, wanted, list(listing.devices)


def launch(stack, platform: MobilePlatform, device, project_dir: Path) -> int:
    """Build, install, start, and capture a frame. Returns an exit code.

    The steps are `mobile.launch`'s — the same ones the verification loop
    runs — so this proof exercises the product's code path, not a copy.
    """
    print()
    say(f"building for {platform}")
    say("  $", stack.commands_for(platform).run or "(none)")
    built, output = build_and_run(stack, platform, project_dir)
    if not built:
        say("ERROR", "the run command the detector produced failed")
        if output:
            print(output[-2000:])
        return 1

    if stack.package_id:
        say("launching", stack.package_id)
    launched, detail = launch_app(stack, platform, device.id)
    if not launched:
        say("  ! launch", detail)

    say("capturing frame")
    frame = Path("device-frame.png")
    if not capture_frame(platform, device.id, frame):
        say("ERROR", "no readable frame was captured")
        return 1
    say("frame", f"{frame} ({frame.stat().st_size} bytes)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--platform", choices=(ANDROID, IOS))
    parser.add_argument(
        "--launch",
        action="store_true",
        help="build, install, start the app and capture a frame (needs a booted device)",
    )
    parser.add_argument(
        "--require-device",
        action="store_true",
        help="exit non-zero when no device is available (for CI)",
    )
    args = parser.parse_args()

    project_dir = Path(args.project_dir).resolve()
    if not project_dir.is_dir():
        say("ERROR", f"no such directory: {project_dir}")
        return 1

    stack, wanted, devices = report_plan(project_dir, args.platform)
    if not stack:
        return 1

    booted = [d for d in devices if d.is_booted and d.platform in wanted]
    if not booted:
        print()
        say("no booted device", "nothing to launch on")
        return 1 if (args.require_device or args.launch) else 0

    if not args.launch:
        print()
        say("read-only", "pass --launch to build, install and capture a frame")
        return 0

    device = booted[0]
    platform = device.platform
    print()
    say("target", f"{device.name} [{device.id}]")
    return launch(stack, platform, device, project_dir)


if __name__ == "__main__":
    sys.exit(main())
