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
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from mobile import detect_stack, list_devices  # noqa: E402
from mobile.readiness import doctor  # noqa: E402
from mobile.stacks import ANDROID, IOS, MobilePlatform  # noqa: E402
from mobile.toolchain import find_tool  # noqa: E402

# A cold emulator boots in about a minute; a first Gradle build pulls the whole
# Android toolchain and can take several.
BOOT_TIMEOUT = 300
BUILD_TIMEOUT = 1800


def say(label: str, value: str = "") -> None:
    print(f"{label:<22}{value}" if value else label, flush=True)


def run(command: list[str] | str, cwd: Path | None = None, timeout: int = 300) -> int:
    """Run a command, streaming nothing and echoing what failed."""
    shell = isinstance(command, str)
    printed = command if shell else " ".join(command)
    say("  $", printed)
    try:
        completed = subprocess.run(  # noqa: S602 - the command comes from our own detector
            command,
            cwd=str(cwd) if cwd else None,
            shell=shell,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        say("  ! failed", str(exc))
        return 1
    return completed.returncode


def capture(command: list[str], timeout: int = 60) -> tuple[int, str]:
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv
            command, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return completed.returncode, completed.stdout


def _is_png(path: Path) -> bool:
    """Whether a real image landed, rather than an empty or truncated file.

    A non-zero exit code is not enough: adb happily exits 0 having written
    nothing when the device goes away mid-capture, and an empty
    `device-frame.png` uploads as an artifact that looks like a success.
    """
    try:
        with path.open("rb") as handle:
            return handle.read(8) == b"\x89PNG\r\n\x1a\n"
    except OSError:
        return False


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
    """Build, install, start, and capture a frame. Returns an exit code."""
    commands = stack.commands_for(platform)
    if not commands.run:
        say("ERROR", f"no run command known for {platform}")
        return 1

    root = Path(stack.project_dir or project_dir)

    print()
    say(f"building for {platform}")
    if run(commands.run, cwd=root, timeout=BUILD_TIMEOUT) != 0:
        say("ERROR", "the run command the detector produced failed")
        return 1

    if platform == ANDROID:
        adb = find_tool("adb") or "adb"
        if stack.package_id:
            say("launching", stack.package_id)
            run(
                [
                    adb,
                    "-s",
                    device.id,
                    "shell",
                    "monkey",
                    "-p",
                    stack.package_id,
                    "-c",
                    "android.intent.category.LAUNCHER",
                    "1",
                ]
            )
            # The activity needs a moment to draw; a frame captured too early
            # is a screenshot of the launcher, which looks like a failed launch.
            time.sleep(5)

        say("capturing frame")
        # Straight to the file, in binary, once. `capture()` decodes stdout as
        # UTF-8, and `screencap -p` emits a PNG — its first byte is 0x89, which
        # is not valid UTF-8, so probing the exit code that way raised
        # UnicodeDecodeError after the app had already launched. Nor is there
        # anything to probe: running the command twice to check it worked and
        # then to keep the output captures two different frames.
        frame = Path("device-frame.png")
        with frame.open("wb") as handle:
            proc = subprocess.run(  # noqa: S603 - fixed argv
                [adb, "-s", device.id, "exec-out", "screencap", "-p"],
                stdout=handle,
                check=False,
            )
        if proc.returncode != 0 or not _is_png(frame):
            say("ERROR", "no readable frame was captured")
            return 1
        say("frame", f"{frame} ({frame.stat().st_size} bytes)")
        return 0

    xcrun = find_tool("xcrun") or "xcrun"
    say("capturing frame")
    frame = Path("device-frame.png")
    if run([xcrun, "simctl", "io", device.id, "screenshot", str(frame)]) != 0:
        say("ERROR", "could not capture a frame")
        return 1
    # simctl writes the file itself and can exit 0 having written nothing
    # useful, so the same check applies on this side.
    if not _is_png(frame):
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
