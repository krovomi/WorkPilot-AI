"""What a phone application changes about the subagent roster.

The language overlays specialise roles by *language*; a mobile project needs
specialisation by **platform**, which is a different axis. A Flutter repository
is Dart, an Expo one is TypeScript, a MAUI one is C#, and all three ask the
same three questions the language overlay cannot answer: does it build for the
platform, does it run on a device, and would a store accept it.

Same discipline as `languages/`: specialise the role that already exists
(`test-runner` learns the platform's build and test commands) and add only the
roles that have no generic equivalent. Two here, not five:

``device-runner``
    Puts the build on an emulator or simulator and reports what happened. The
    generic `test-runner` runs a suite; nothing in the default roster installs
    an artefact onto a device, and that is where mobile defects actually show.

``store-readiness-auditor``
    Reads the manifest, the entitlements, the permissions and the metadata
    against the rules Apple and Google reject on. Those rejections cost days
    and no test in the repository catches any of them.

A `mobile-ui-reviewer` was considered and dropped: `code-reviewer` and the
`design-check` workflow phase already read UI code, and a third reader of the
same files earns its roster slot from nobody.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .phases import AgentSpec

logger = logging.getLogger(__name__)

__all__ = ["MobileOverlay", "overlay_for", "MOBILE_ROLES"]

MOBILE_ROLES = ("device-runner", "store-readiness-auditor")


@dataclass(frozen=True)
class MobileOverlay:
    """The mobile half of a roster: commands to fold in, roles to add."""

    framework: str
    platforms: tuple[str, ...]
    test_commands: list[str] = field(default_factory=list)
    build_commands: list[str] = field(default_factory=list)
    extra_agents: dict[str, Any] = field(default_factory=dict)
    notes: str = ""


_DEVICE_RUNNER = AgentSpec(
    description=(
        "Installs the app on an Android emulator or iOS simulator and reports "
        "what it does there. Use when a change has to be seen running on a "
        "device rather than only compiling."
    ),
    prompt=(
        "You put a mobile build on a device and report what happened. You do "
        "not fix anything.\n\n"
        "Steps:\n"
        "1. Find a booted device — `adb devices` on Android, "
        "`xcrun simctl list devices booted` on iOS. If none is booted, boot one "
        "(`emulator -avd <name>` / `xcrun simctl boot <udid>`) and wait for it.\n"
        "2. Build and install with the commands given to you. Never invent a "
        "build command: a wrong one fails after the whole compile and the error "
        "reads like a source defect.\n"
        "3. Launch the app and capture evidence — `adb exec-out screencap -p > "
        "shot.png`, or `xcrun simctl io booted screenshot shot.png`.\n"
        "4. Collect the log for the app only (`adb logcat --pid=$(adb shell pidof "
        "-s <package>)`, `xcrun simctl spawn booted log stream --predicate "
        "'processImagePath endswith \"<App>\"'`). The full device log is noise.\n\n"
        "Report: did it install, did it launch, what is on screen, and every "
        "crash or ANR with its stack. If no device is available, say so once "
        "with the reason — do not retry a toolchain that is not installed."
    ),
    tools=["Bash", "Read", "Grep", "Glob"],
)

_STORE_AUDITOR = AgentSpec(
    description=(
        "Read-only store-submission auditor. Use before a release, or when a "
        "change touches permissions, entitlements, privacy or app metadata."
    ),
    prompt=(
        "You audit a mobile app against what the stores actually reject on, and "
        "nothing else.\n\n"
        "Android — read AndroidManifest.xml, the Gradle config and the Play "
        "policy surface: permissions declared but never requested (and the "
        "reverse), a targetSdk below Play's current floor, missing data-safety "
        "declarations, debuggable or cleartext traffic left on in release, "
        "an unsigned or debug-signed release artefact.\n\n"
        "iOS — read Info.plist, the entitlements and the privacy manifest: a "
        "sensitive API used without its NS…UsageDescription, a missing "
        "PrivacyInfo.xcprivacy for an SDK that needs one, account creation with "
        "no account deletion path, private API usage, an ATS exception with no "
        "justification.\n\n"
        "For every finding: the file, the line, the rule it breaks, and what the "
        "reviewer would see. If you cannot name the rule, it is a suggestion, "
        "not a finding — label it as such. Never modify files."
    ),
    tools=["Read", "Grep", "Glob"],
    model="sonnet",
)


def _commands(stack: Any) -> tuple[list[str], list[str]]:
    """The stack's own test and build commands, as the roster should see them.

    Keyed by the command, not by the platform: a cross-platform framework runs
    one test command for both heads, and listing `flutter test` twice under two
    labels reads as two different commands to anyone who did not write them.
    """
    tests: dict[str, list[str]] = {}
    builds: dict[str, list[str]] = {}
    for platform in stack.platforms:
        commands = stack.commands_for(platform)
        label = "Android" if platform == "android" else "iOS"
        if commands.test:
            tests.setdefault(commands.test, []).append(label)
        if commands.build:
            builds.setdefault(commands.build, []).append(f"{label} build")
        if commands.run:
            builds.setdefault(commands.run, []).append(f"{label} run on a device")

    def _render(entries: dict[str, list[str]]) -> list[str]:
        return [f"{cmd:<52}# {', '.join(labels)}" for cmd, labels in entries.items()]

    return _render(tests), _render(builds)


def overlay_for(project_dir: Path | str | None) -> MobileOverlay | None:
    """The mobile overlay for a project, or ``None`` when it is not one.

    Import failures and detection failures both degrade to "no overlay": a
    roster without the mobile specialists still builds, an exception here
    stops the run.
    """
    if not project_dir:
        return None
    try:
        from mobile import detect_stack

        stack = detect_stack(project_dir)
    except Exception as exc:  # noqa: BLE001
        logger.debug("mobile detection unavailable for %s: %s", project_dir, exc)
        return None

    if not stack:
        return None

    tests, builds = _commands(stack)
    return MobileOverlay(
        framework=stack.framework,
        platforms=stack.platforms,
        test_commands=tests,
        build_commands=builds,
        extra_agents={
            "device-runner": _DEVICE_RUNNER,
            "store-readiness-auditor": _STORE_AUDITOR,
        },
        notes=stack.notes,
    )
