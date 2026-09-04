"""The section every agent phase gets when the task is a phone application.

Same contract as `prompts.constitution_section`: one public function, cheap
when it does not apply, and read by the planner, every coding subtask and the
QA reviewer rather than reimplemented three times.

What goes in is what a model gets wrong when left to remember it:

* **the commands of this exact stack** — `flutter build ios --simulator` and
  `xcodebuild -workspace` are not interchangeable, and a wrong one fails after
  the whole compile;
* **what this machine cannot do** — an iOS target on Linux is not a bug to fix
  by retrying, and an agent told so writes "unverified on iOS" in its report
  instead of burning a QA cycle proving it;
* **the platform rules that have no equivalent on the web** — permissions
  declared before use, no work on the main thread, a back gesture that must not
  lose state, a store review that rejects on things no test catches.

What deliberately does not go in: a tutorial. The model knows Kotlin. It does
not know which of the four buildable heads in *this* repository is the one the
task is about.
"""

from __future__ import annotations

import os
from pathlib import Path

from .readiness import doctor
from .stacks import (
    ANDROID,
    IOS,
    MobilePlatform,
    MobileStack,
    detect_stack,
    normalise_targets,
)

__all__ = ["mobile_section", "requested_targets", "TARGETS_ENV"]

# Set per task by the Kanban (see `applyMobileTargets` in the Electron main
# process). The same lever as TDD_MODE: a per-task choice reaches the backend
# as an environment variable rather than as a new argument threaded through
# every runner.
TARGETS_ENV = "WORKPILOT_MOBILE_TARGETS"

_PLATFORM_RULES: dict[MobilePlatform, tuple[str, ...]] = {
    ANDROID: (
        "Declare every runtime permission in AndroidManifest.xml **and** request "
        "it at the point of use; a permission declared but never requested fails "
        "silently on Android 13+.",
        "Nothing blocking on the main thread — I/O, database and network go to a "
        "coroutine dispatcher. StrictMode in a debug build is what catches this.",
        "Handle configuration changes and process death: state that only lives in "
        "an Activity field is gone after a rotation or a low-memory kill.",
        "Respect the back gesture and the predictive-back API; swallowing back is "
        "the single most common Play Store review complaint.",
        "Target the current compileSdk/targetSdk the project already declares — "
        "raising it is a separate task with its own testing.",
    ),
    IOS: (
        "Every privacy-sensitive API needs its `NS…UsageDescription` string in "
        "Info.plist. Without it the app does not prompt — it crashes on first use.",
        "UI work on the main actor only; mark long work `async` and keep it off it. "
        "A hitch on the main thread is what a reviewer sees as 'janky'.",
        "Respect the safe area and Dynamic Type. A layout pinned to fixed points "
        "breaks on the smallest device and on the largest accessibility text size.",
        "State restoration matters: iOS suspends and terminates apps freely, and "
        "coming back to a blank screen reads as a crash to the user.",
        "App Store Review Guidelines reject on things tests do not catch — account "
        "deletion when there is sign-up, a privacy manifest for the SDKs used, "
        "and no private API usage.",
    ),
}

_SHARED_RULES = (
    "Test on a **device or emulator**, not only in unit tests. A phone UI that "
    "compiles and never renders correctly is the normal failure mode here.",
    "Handle the network being absent or slow: offline is a state a phone is in "
    "several times a day, not an error case.",
    "Watch binary size and cold-start time; both are user-visible on a phone in "
    "a way they never are on a desktop.",
    "Accessibility labels on every interactive element — TalkBack and VoiceOver "
    "are the only way some users have to operate the app at all.",
)


def requested_targets(
    project_dir: Path | str | None = None,
    stack: MobileStack | None = None,
) -> tuple[MobilePlatform, ...]:
    """Which platforms this task is for.

    The per-task choice wins when there is one — a Kanban card can say "Android
    only" about a repository that also ships an iOS head, and building both
    would be work nobody asked for. Otherwise every platform the project
    actually has.
    """
    explicit = normalise_targets(os.environ.get(TARGETS_ENV, ""))
    resolved = stack if stack is not None else detect_stack(project_dir)
    available = resolved.platforms if resolved else ()

    if explicit and available:
        # Intersect: a card asking for iOS on an Android-only project is a
        # mistake worth ignoring rather than obeying.
        narrowed = tuple(p for p in explicit if p in available)
        return narrowed or available
    return explicit or available


def _commands_block(stack: MobileStack, platform: MobilePlatform) -> list[str]:
    commands = stack.commands_for(platform)
    label = "Android" if platform == ANDROID else "iOS"
    lines = [f"### {label}", ""]
    for title, value in (
        ("Run on a booted device", commands.run),
        ("Build", commands.build),
        ("Test", commands.test),
        ("Lint", commands.lint),
    ):
        if value:
            lines.append(f"- {title}: `{value}`")
    if commands.artifact:
        lines.append(f"- Artefact: `{commands.artifact}`")
    if commands.notes:
        lines.append(f"- Watch out: {commands.notes}")
    lines.append("")
    return lines


def mobile_section(
    project_dir: Path | str | None,
    targets: tuple[MobilePlatform, ...] | None = None,
    *,
    include_doctor: bool = True,
) -> str:
    """The mobile prompt section, or "" when the task is not a mobile one.

    Never raises. A phase that cannot get this section runs without it, which
    costs specialisation; a phase that crashes trying to build it costs the
    build.
    """
    try:
        stack = detect_stack(project_dir)
        if not stack:
            return ""

        platforms = targets or requested_targets(project_dir, stack=stack)
        platforms = (
            tuple(p for p in platforms if p in stack.platforms) or stack.platforms
        )

        names = " and ".join("Android" if p == ANDROID else "iOS" for p in platforms)
        lines = [
            "## Mobile application",
            "",
            f"This project is a **{stack.framework}** application targeting **{names}**.",
            f"Its mobile root is `{stack.project_dir}`"
            + (f" (`{stack.package_id}`)." if stack.package_id else "."),
            "",
            "There is no localhost URL to open here: the app is compiled, installed "
            "onto a device or an emulator, and looked at. Plan and verify accordingly.",
            "",
            "## Commands for this stack",
            "",
        ]
        for platform in platforms:
            lines.extend(_commands_block(stack, platform))

        if include_doctor:
            reports = doctor(project_dir, platforms=platforms, stack=stack)
            blocked = [r for r in reports.values() if not r.ok]
            if blocked:
                lines.extend(
                    [
                        "## What this machine cannot do",
                        "",
                    ]
                )
                for report in blocked:
                    label = "Android" if report.platform == ANDROID else "iOS"
                    lines.append(f"- **{label}** — {report.blocker}.")
                    remedies = [c.remedy for c in report.checks if c.remedy]
                    if remedies:
                        lines.append(f"  {remedies[0]}")
                lines.extend(
                    [
                        "",
                        "Do not spend attempts working around this. Implement the change, "
                        "verify what can be verified here, and state plainly in your "
                        "report which platform went unverified and why. A build that "
                        "cannot run is not a defect in the code you wrote.",
                        "",
                    ]
                )

        lines.extend(["## Rules that apply to phone applications", ""])
        for platform in platforms:
            label = "Android" if platform == ANDROID else "iOS"
            lines.append(f"**{label}**")
            lines.extend(f"- {rule}" for rule in _PLATFORM_RULES[platform])
            lines.append("")
        lines.append("**Both platforms**")
        lines.extend(f"- {rule}" for rule in _SHARED_RULES)

        return "\n".join(lines).rstrip() + "\n"
    except Exception:  # noqa: BLE001 - a missing section never stops a phase
        return ""
