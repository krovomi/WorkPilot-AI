"""The emulators and simulators actually available on this machine.

A phone app has no localhost URL to open. What the Kanban previews is a device:
an Android Virtual Device or an iOS Simulator, booted, with the app installed
on it. So "which devices exist here" is the mobile equivalent of "which port is
the dev server on", and it has to be answered before anything can be shown.

Every command here is a **read** — listing AVDs, listing simulators, listing
attached devices. Booting one is a separate, explicit action, because booting
an emulator takes a minute and half a gigabyte of RAM and is not something a
detection pass should do on its own.

Absence is a result, not an error. A Linux machine has no simulators and a
machine without the Android SDK has no emulators; both are ordinary, and the
answer that helps is "none, because <the tool was not found>" rather than an
exception the caller has to interpret.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .stacks import ANDROID, IOS, MobilePlatform
from .toolchain import android_sdk_root, find_tool

__all__ = ["MobileDevice", "DeviceListing", "list_devices"]

# Listing is a local command; anything slower than this is a hung adb server or
# a simulator service that will not answer, and waiting longer only delays the
# same "none found".
_TIMEOUT = 20


@dataclass(frozen=True)
class MobileDevice:
    """One thing an app can be installed onto."""

    id: str
    name: str
    platform: MobilePlatform
    # "emulator" (Android AVD) | "simulator" (iOS) | "physical"
    kind: str
    state: str = "shutdown"
    runtime: str = ""

    @property
    def is_booted(self) -> bool:
        return self.state in {"booted", "device", "online"}

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "platform": self.platform,
            "kind": self.kind,
            "state": self.state,
            "runtime": self.runtime,
            "isBooted": self.is_booted,
        }


@dataclass(frozen=True)
class DeviceListing:
    """Devices found, and — when none were — why."""

    devices: tuple[MobileDevice, ...] = ()
    unavailable: dict[str, str] = None  # type: ignore[assignment]

    def to_dict(self) -> dict:
        return {
            "devices": [d.to_dict() for d in self.devices],
            "unavailable": dict(self.unavailable or {}),
        }


def _run(command: list[str], cwd: Path | None = None) -> tuple[int, str]:
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            command,
            capture_output=True,
            text=True,
            timeout=_TIMEOUT,
            cwd=str(cwd) if cwd else None,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return completed.returncode, (completed.stdout or "") + (completed.stderr or "")


def _android_avds() -> list[MobileDevice]:
    emulator = find_tool("emulator")
    if not emulator:
        return []
    code, output = _run([emulator, "-list-avds"])
    if code != 0:
        return []
    devices: list[MobileDevice] = []
    for line in output.splitlines():
        name = line.strip()
        # The emulator binary prints warnings to the same stream; an AVD name
        # never contains a space, which is the cheapest way to tell them apart.
        if not name or " " in name or name.startswith("INFO"):
            continue
        devices.append(
            MobileDevice(
                id=name,
                name=name,
                platform=ANDROID,
                kind="emulator",
                state="shutdown",
            )
        )
    return devices


def _android_attached() -> list[MobileDevice]:
    """Devices `adb` can see right now — booted emulators and plugged-in phones."""
    adb = find_tool("adb")
    if not adb:
        return []
    code, output = _run([adb, "devices", "-l"])
    if code != 0:
        return []
    devices: list[MobileDevice] = []
    for line in output.splitlines()[1:]:
        line = line.strip()
        if not line or "offline" in line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        serial, state = parts[0], parts[1]
        model = next(
            (p.split(":", 1)[1] for p in parts[2:] if p.startswith("model:")), serial
        )
        devices.append(
            MobileDevice(
                id=serial,
                name=model.replace("_", " "),
                platform=ANDROID,
                kind="emulator" if serial.startswith("emulator-") else "physical",
                state=state,
            )
        )
    return devices


def _merge_android(
    avds: list[MobileDevice], attached: list[MobileDevice]
) -> list[MobileDevice]:
    """One entry per device, preferring the booted one.

    A booted AVD appears twice — once by name from `-list-avds`, once by serial
    from `adb devices`. Listing both makes the picker offer the same phone under
    two labels, and the shutdown-looking one is the trap: selecting it starts a
    second emulator.
    """
    booted_names = set()
    adb = find_tool("adb")
    for device in attached:
        if device.kind != "emulator" or not adb:
            continue
        code, output = _run([adb, "-s", device.id, "emu", "avd", "name"])
        if code == 0:
            name = output.strip().splitlines()[0].strip() if output.strip() else ""
            if name:
                booted_names.add(name)

    merged = list(attached)
    merged.extend(avd for avd in avds if avd.name not in booted_names)
    return merged


def _ios_simulators() -> list[MobileDevice]:
    xcrun = find_tool("xcrun")
    if not xcrun:
        return []
    code, output = _run([xcrun, "simctl", "list", "devices", "available", "--json"])
    if code != 0 or not output.strip():
        return []
    try:
        payload = json.loads(output)
    except (json.JSONDecodeError, ValueError):
        return []

    devices: list[MobileDevice] = []
    for runtime, entries in (payload.get("devices") or {}).items():
        # "com.apple.CoreSimulator.SimRuntime.iOS-18-2" -> "iOS 18.2"
        label = runtime.rsplit(".", 1)[-1].replace("-", " ", 1).replace("-", ".")
        for entry in entries or []:
            if not entry.get("isAvailable", True):
                continue
            devices.append(
                MobileDevice(
                    id=str(entry.get("udid", "")),
                    name=str(entry.get("name", "")),
                    platform=IOS,
                    kind="simulator",
                    state=str(entry.get("state", "Shutdown")).lower(),
                    runtime=label,
                )
            )
    return devices


def list_devices(
    platforms: tuple[MobilePlatform, ...] | None = None,
) -> DeviceListing:
    """Everything the app could be installed onto, with reasons for what is missing.

    ``platforms`` narrows the search; omitting it asks for both. The reasons are
    the useful half of the answer — "no Android SDK on PATH; set ANDROID_HOME"
    is actionable in a way that an empty list is not.
    """
    wanted = platforms or (ANDROID, IOS)
    devices: list[MobileDevice] = []
    unavailable: dict[str, str] = {}

    if ANDROID in wanted:
        if not find_tool("adb") and not find_tool("emulator"):
            root = android_sdk_root()
            unavailable[ANDROID] = (
                "Android SDK platform-tools not found on PATH"
                + (f" (looked under {root})" if root else "")
                + ". Install the SDK and set ANDROID_HOME, or open Android Studio once."
            )
        else:
            devices.extend(_merge_android(_android_avds(), _android_attached()))
            if not devices:
                unavailable[ANDROID] = (
                    "Android SDK found but no AVD is defined. Create one with "
                    "`avdmanager create avd` or Android Studio's Device Manager."
                )

    if IOS in wanted:
        if not find_tool("xcrun"):
            unavailable[IOS] = (
                "xcrun not found. iOS simulators exist only on macOS with Xcode "
                "installed; on Windows or Linux an iOS build has to run on a Mac "
                "runner or a remote build service."
            )
        else:
            simulators = _ios_simulators()
            if simulators:
                devices.extend(simulators)
            else:
                unavailable[IOS] = (
                    "Xcode is installed but no simulator is available. Add a "
                    "runtime in Xcode → Settings → Components."
                )

    # Booted first, then by name: the picker's default should be the device the
    # user is already looking at.
    devices.sort(key=lambda d: (not d.is_booted, d.platform, d.name))
    return DeviceListing(devices=tuple(devices), unavailable=unavailable)
