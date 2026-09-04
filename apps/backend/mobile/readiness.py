"""Can this machine build this app for this platform — and if not, what is missing.

The expensive failure in mobile work is discovering, an hour into a build, that
the toolchain was never there: an iOS target on a Linux CI runner, an Android
build with no SDK, a Flutter project with no Flutter. None of those are fixable
by the agent retrying, and all of them are answerable in milliseconds before
the phase starts.

So the doctor runs *first*, and its verdict is a phase input rather than a
diagnostic command a human remembers to type. A `blocked` platform is one where
the honest thing is to say so in the plan — "iOS cannot be built here, the
change is written but unverified on that platform" — instead of producing a red
build that reads like a code defect.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from .stacks import ANDROID, IOS, MobilePlatform, MobileStack, detect_stack
from .toolchain import android_sdk_root, find_tool

__all__ = ["ToolCheck", "PlatformReport", "doctor"]


@dataclass(frozen=True)
class ToolCheck:
    """One thing that either is or is not installed."""

    tool: str
    ok: bool
    detail: str = ""
    remedy: str = ""
    required: bool = True

    def to_dict(self) -> dict:
        return {
            "tool": self.tool,
            "ok": self.ok,
            "detail": self.detail,
            "remedy": self.remedy,
            "required": self.required,
        }


@dataclass(frozen=True)
class PlatformReport:
    """Whether one platform can be built here."""

    platform: MobilePlatform
    ok: bool
    checks: tuple[ToolCheck, ...]
    blocker: str = ""

    def to_dict(self) -> dict:
        return {
            "platform": self.platform,
            "ok": self.ok,
            "blocker": self.blocker,
            "checks": [c.to_dict() for c in self.checks],
        }


def _is_macos() -> bool:
    try:
        from core.platform import is_macos

        return bool(is_macos())
    except Exception:  # noqa: BLE001
        import platform as _platform

        return _platform.system().lower() == "darwin"


def _check(tool: str, remedy: str, *, required: bool = True) -> ToolCheck:
    path = find_tool(tool) or shutil.which(tool) or ""
    return ToolCheck(
        tool=tool,
        ok=bool(path),
        detail=path or "not found",
        remedy="" if path else remedy,
        required=required,
    )


def _framework_checks(framework: str) -> list[ToolCheck]:
    """The tool the framework itself needs, on top of the platform SDK."""
    per_framework = {
        "flutter": ("flutter", "Install the Flutter SDK and put `flutter` on PATH."),
        "react-native": ("node", "Install Node.js 20+."),
        "expo": ("node", "Install Node.js 20+."),
        "capacitor": ("node", "Install Node.js 20+."),
        "dotnet-maui": (
            "dotnet",
            "Install the .NET SDK, then `dotnet workload install maui`.",
        ),
    }
    entry = per_framework.get(framework)
    return [_check(entry[0], entry[1])] if entry else []


def _android_report(stack: MobileStack | None) -> PlatformReport:
    checks = [
        _check(
            "adb",
            "Install the Android SDK platform-tools and set ANDROID_HOME "
            "(Android Studio installs both).",
        ),
        _check(
            "emulator",
            "Install the Android SDK emulator package — needed only to preview "
            "on a virtual device, not to build.",
            required=False,
        ),
    ]
    if stack:
        checks.extend(_framework_checks(stack.framework))
        gradle_project = stack.framework in {
            "android-native",
            "kotlin-multiplatform",
            "react-native",
        }
        if gradle_project:
            wrapper = Path(stack.project_dir) / "gradlew"
            has_wrapper = (
                wrapper.exists() or (Path(stack.project_dir) / "gradlew.bat").exists()
            )
            # The remedy is keyed on `gradle_ok`, not on `has_wrapper`: a
            # remedy attached to a check that passed — "you have Gradle, now
            # commit a wrapper" — reads as an unsolved problem in every UI
            # that lists the checks.
            gradle_ok = has_wrapper or bool(
                find_tool("gradle") or shutil.which("gradle")
            )
            checks.append(
                ToolCheck(
                    tool="gradle",
                    ok=gradle_ok,
                    detail="gradle wrapper" if has_wrapper else "gradle on PATH",
                    remedy=""
                    if gradle_ok
                    else "Commit a Gradle wrapper (`gradle wrapper`) or install Gradle.",
                )
            )
        java = _check(
            "java",
            "Install a JDK 17+ (Temurin, Zulu…) and set JAVA_HOME — the Android "
            "Gradle plugin refuses to start without one.",
        )
        checks.append(java)

    required_failures = [c for c in checks if c.required and not c.ok]
    blocker = ""
    if required_failures:
        names = ", ".join(c.tool for c in required_failures)
        root = android_sdk_root()
        blocker = f"missing: {names}" + (f" (SDK root: {root})" if root else "")
    return PlatformReport(
        platform=ANDROID,
        ok=not required_failures,
        checks=tuple(checks),
        blocker=blocker,
    )


def _ios_report(stack: MobileStack | None) -> PlatformReport:
    if not _is_macos():
        # Not a missing tool — a platform constraint. Apple's toolchain does not
        # exist off macOS, so reporting it as "install xcodebuild" would send an
        # agent looking for a package that cannot be installed.
        check = ToolCheck(
            tool="xcodebuild",
            ok=False,
            detail="this machine is not macOS",
            remedy=(
                "iOS builds require macOS with Xcode. Use a Mac runner "
                "(GitHub Actions `macos-latest`, a self-hosted Mac) or a remote "
                "build service such as EAS Build or Codemagic."
            ),
        )
        return PlatformReport(
            platform=IOS,
            ok=False,
            checks=(check,),
            blocker="iOS cannot be built on this machine: Apple's toolchain is macOS-only",
        )

    checks = [
        _check(
            "xcodebuild",
            "Install Xcode from the App Store, then `xcode-select --install`.",
        ),
        _check(
            "xcrun", "Install the Xcode command line tools: `xcode-select --install`."
        ),
    ]
    if stack:
        checks.extend(_framework_checks(stack.framework))
        needs_pods = (Path(stack.project_dir) / "Podfile").exists()
        if needs_pods:
            checks.append(
                _check("pod", "Install CocoaPods: `sudo gem install cocoapods`.")
            )

    required_failures = [c for c in checks if c.required and not c.ok]
    return PlatformReport(
        platform=IOS,
        ok=not required_failures,
        checks=tuple(checks),
        blocker=(
            "missing: " + ", ".join(c.tool for c in required_failures)
            if required_failures
            else ""
        ),
    )


def doctor(
    project_dir: Path | str | None = None,
    platforms: tuple[MobilePlatform, ...] | None = None,
    stack: MobileStack | None = None,
) -> dict[MobilePlatform, PlatformReport]:
    """A per-platform verdict on whether a build can happen here.

    ``stack`` may be passed by a caller that has already detected it — the
    Kanban detects once and asks several questions of the result, and detecting
    twice would let the two answers disagree.
    """
    resolved = stack or detect_stack(project_dir)
    wanted = platforms or (resolved.platforms if resolved else (ANDROID, IOS))

    reports: dict[MobilePlatform, PlatformReport] = {}
    if ANDROID in wanted:
        reports[ANDROID] = _android_report(resolved)
    if IOS in wanted:
        reports[IOS] = _ios_report(resolved)
    return reports
