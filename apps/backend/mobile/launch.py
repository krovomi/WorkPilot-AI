"""Put a phone app on a device and read back what it showed and printed.

The one implementation of *build → install → launch → capture*, used by
`scripts/mobile_device_check.py` (the CI proof that the computed commands are
commands Gradle accepts) and by the verification loop (`verify.mobile`). It
runs **the commands `stacks.py` computed**, never commands written here — a
copy would pass while the product's own was wrong.

Everything returns a value instead of printing, so the script can print it and
the verification can record it.
"""

from __future__ import annotations

import re
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from core.platform import split_command

from .stacks import ANDROID, MobilePlatform, MobileStack
from .toolchain import find_tool

__all__ = [
    "BOOT_TIMEOUT",
    "BUILD_TIMEOUT",
    "DeviceRun",
    "is_png",
    "boot_device",
    "build_and_run",
    "launch_app",
    "capture_frame",
    "app_log",
    "startup_ms",
    "jank_stats",
]

# A cold emulator boots in about a minute; a first Gradle build pulls the whole
# Android toolchain and can take several.
BOOT_TIMEOUT = 300
BUILD_TIMEOUT = 1800


@dataclass
class DeviceRun:
    platform: str
    device_id: str = ""
    built: bool = False
    launched: bool = False
    frame: str = ""
    startup_ms: float | None = None
    jank: dict = field(default_factory=dict)
    log_tail: str = ""
    steps: list[str] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def is_png(path: Path) -> bool:
    """Whether a real image landed, rather than an empty or truncated file.

    adb exits 0 having written nothing when the device goes away mid-capture.
    """
    try:
        with path.open("rb") as handle:
            return handle.read(8) == b"\x89PNG\r\n\x1a\n"
    except OSError:
        return False


def _run(
    command: list[str] | str, cwd: Path | None = None, timeout: int = 300
) -> tuple[int, str]:
    # A detected command is a string with no shell syntax: split it rather
    # than hand it to a shell.
    argv = split_command(command, cwd) if isinstance(command, str) else command
    try:
        completed = subprocess.run(  # noqa: S603 - commands from our own detector
            argv,
            cwd=str(cwd) if cwd else None,
            timeout=timeout,
            check=False,
            capture_output=True,
            text=True,
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, str(exc)
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")


def boot_device(device, timeout: int = BOOT_TIMEOUT) -> tuple[bool, str]:
    """Boot an emulator/simulator that is not running. ``(ok, detail)``."""
    if device.is_booted:
        return True, "already booted"
    if device.platform == ANDROID:
        emulator = find_tool("emulator")
        adb = find_tool("adb") or "adb"
        if not emulator:
            return False, "the Android emulator binary is not on PATH"
        subprocess.Popen(  # noqa: S603 - fixed argv
            [
                emulator,
                "-avd",
                device.name,
                "-no-snapshot-load",
                "-no-audio",
                "-no-window",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            code, out = _run(
                [adb, "shell", "getprop", "sys.boot_completed"], timeout=10
            )
            if code == 0 and out.strip() == "1":
                return True, "booted"
            time.sleep(3)
        return False, f"the emulator did not finish booting within {timeout}s"
    xcrun = find_tool("xcrun") or "xcrun"
    code, out = _run([xcrun, "simctl", "boot", device.id], timeout=120)
    if code != 0 and "current state: Booted" not in out:
        return False, out.strip()[:300]
    return True, "booted"


def build_and_run(
    stack: MobileStack, platform: MobilePlatform, project_dir: Path
) -> tuple[bool, str]:
    """The stack's own `run` command for ``platform``. ``(ok, output tail)``."""
    commands = stack.commands_for(platform)
    if not commands.run:
        return False, f"no run command known for {platform}"
    root = Path(stack.project_dir or project_dir)
    code, out = _run(commands.run, cwd=root, timeout=BUILD_TIMEOUT)
    return code == 0, out[-6000:]


def launch_app(
    stack: MobileStack, platform: MobilePlatform, device_id: str
) -> tuple[bool, str]:
    if platform == ANDROID:
        if not stack.package_id:
            return True, "no package id: the run command started the app"
        adb = find_tool("adb") or "adb"
        code, out = _run(
            [
                adb,
                "-s",
                device_id,
                "shell",
                "monkey",
                "-p",
                stack.package_id,
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            ],
            timeout=60,
        )
        # The activity needs a moment to draw; a frame captured too early is a
        # screenshot of the launcher, which looks like a failed launch.
        time.sleep(5)
        return code == 0, out.strip()[:300]
    if not stack.package_id:
        return True, "no bundle id: the run command started the app"
    xcrun = find_tool("xcrun") or "xcrun"
    code, out = _run(
        [xcrun, "simctl", "launch", device_id, stack.package_id], timeout=60
    )
    time.sleep(4)
    return code == 0, out.strip()[:300]


def capture_frame(platform: MobilePlatform, device_id: str, frame: Path) -> bool:
    frame.parent.mkdir(parents=True, exist_ok=True)
    if platform == ANDROID:
        adb = find_tool("adb") or "adb"
        # Straight to the file, in binary, once: `screencap -p` emits a PNG
        # whose first byte is not valid UTF-8.
        try:
            with frame.open("wb") as handle:
                proc = subprocess.run(  # noqa: S603 - fixed argv
                    [adb, "-s", device_id, "exec-out", "screencap", "-p"],
                    stdout=handle,
                    check=False,
                    timeout=60,
                )
        except (OSError, subprocess.SubprocessError):
            return False
        return proc.returncode == 0 and is_png(frame)
    xcrun = find_tool("xcrun") or "xcrun"
    code, _ = _run(
        [xcrun, "simctl", "io", device_id, "screenshot", str(frame)], timeout=60
    )
    return code == 0 and is_png(frame)


def app_log(
    stack: MobileStack, platform: MobilePlatform, device_id: str, lines: int = 400
) -> str:
    """The app's own log — never the whole device's, which is system noise."""
    if platform == ANDROID:
        adb = find_tool("adb") or "adb"
        pid = ""
        if stack.package_id:
            _code, out = _run(
                [adb, "-s", device_id, "shell", "pidof", stack.package_id], timeout=15
            )
            pid = out.strip().split()[0] if out.strip() else ""
        command = [adb, "-s", device_id, "logcat", "-d", "-t", str(lines)]
        if pid.isdigit():
            command += ["--pid", pid]
        else:
            command += ["AndroidRuntime:E", "*:S"]  # at least the crashes
        _code, out = _run(command, timeout=30)
        return out[-20_000:]
    xcrun = find_tool("xcrun") or "xcrun"
    predicate = (
        f'subsystem == "{stack.package_id}" OR process == "{stack.package_id.rsplit(".", 1)[-1]}"'
        if stack.package_id
        else 'eventType == "logEvent"'
    )
    _code, out = _run(
        [
            xcrun,
            "simctl",
            "spawn",
            device_id,
            "log",
            "show",
            "--last",
            "2m",
            "--style",
            "compact",
            "--predicate",
            predicate,
        ],
        timeout=60,
    )
    return out[-20_000:]


_TOTAL_TIME = re.compile(r"TotalTime:\s*(\d+)")


def startup_ms(
    stack: MobileStack, platform: MobilePlatform, device_id: str
) -> float | None:
    """Cold start time as Android measures it (`am start -W`), else None."""
    if platform != ANDROID or not stack.package_id:
        return None
    adb = find_tool("adb") or "adb"
    _run(
        [adb, "-s", device_id, "shell", "am", "force-stop", stack.package_id],
        timeout=20,
    )
    _code, resolved = _run(
        [
            adb,
            "-s",
            device_id,
            "shell",
            "cmd",
            "package",
            "resolve-activity",
            "--brief",
            stack.package_id,
        ],
        timeout=20,
    )
    component = next((ln.strip() for ln in resolved.splitlines() if "/" in ln), "")
    if not component:
        return None
    _code, out = _run(
        [adb, "-s", device_id, "shell", "am", "start", "-W", "-n", component],
        timeout=60,
    )
    match = _TOTAL_TIME.search(out)
    return float(match.group(1)) if match else None


_GFX = {
    "frames": re.compile(r"Total frames rendered:\s*(\d+)"),
    "janky": re.compile(r"Janky frames:\s*(\d+)"),
    "p90_ms": re.compile(r"90th percentile:\s*(\d+)ms"),
    "p99_ms": re.compile(r"99th percentile:\s*(\d+)ms"),
}


def jank_stats(stack: MobileStack, platform: MobilePlatform, device_id: str) -> dict:
    """Frames rendered and janky frames (`dumpsys gfxinfo`), Android only."""
    if platform != ANDROID or not stack.package_id:
        return {}
    adb = find_tool("adb") or "adb"
    _code, out = _run(
        [adb, "-s", device_id, "shell", "dumpsys", "gfxinfo", stack.package_id],
        timeout=30,
    )
    stats = {}
    for key, pattern in _GFX.items():
        match = pattern.search(out)
        if match:
            stats[key] = int(match.group(1))
    return stats
