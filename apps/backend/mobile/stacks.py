"""Which mobile stack a project is, and what one does with it.

Detection reads the files on disk and nothing else — no model, no network — so
it is cheap enough to run on every build and honest enough to be trusted by the
prompt layer, the subagent roster and the Kanban alike.

Two things are deliberately kept apart:

**Platform** is where the app runs: ``android`` or ``ios``. It is what a user
picks in the Kanban ("build me the Android app"), and what decides whether the
machine even has a usable toolchain.

**Framework** is what the code is written with: a native Android app, an Xcode
project, Flutter, React Native, Expo, .NET MAUI, Kotlin Multiplatform,
Capacitor. It decides the commands.

The pair matters because most of these frameworks ship both platforms from one
tree: `flutter build ios` and `flutter build apk` are the same project. A
single "project type" string — the shape the web emulator uses — cannot say
"this repo targets both, but only Android can be built on this machine".
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

__all__ = [
    "ANDROID",
    "IOS",
    "MobilePlatform",
    "MobileStack",
    "PlatformCommands",
    "detect_stack",
    "is_mobile_project",
    "normalise_targets",
]

MobilePlatform = str  # "android" | "ios"

ANDROID: MobilePlatform = "android"
IOS: MobilePlatform = "ios"

# Directories that are build output or vendored dependencies. Walking into them
# turns a 20 ms detection into a multi-second one and, worse, finds an
# `AndroidManifest.xml` belonging to a dependency rather than to the project.
_PRUNED = {
    "node_modules",
    "build",
    "Build",
    "DerivedData",
    "Pods",
    ".git",
    ".gradle",
    ".dart_tool",
    "bin",
    "obj",
    "vendor",
    "Carthage",
    ".venv",
    "venv",
}

# How deep to look for a nested mobile project. A monorepo puts the app at
# `apps/mobile/` or `packages/app/`; nobody puts it eight levels down, and
# scanning as if they might is how detection starts costing more than the
# phase it informs.
_MAX_DEPTH = 3


@dataclass(frozen=True)
class PlatformCommands:
    """What to run for one platform of one framework.

    ``run`` is the command that puts the app on a booted device — the one the
    Kanban preview button calls. ``build`` produces the artefact a store would
    take. They are separate because they fail differently: a failing `run` is
    usually a device problem, a failing `build` is usually a signing one, and
    reporting the second as the first sends an agent hunting in the wrong place.
    """

    run: str = ""
    build: str = ""
    test: str = ""
    lint: str = ""
    artifact: str = ""
    notes: str = ""


@dataclass(frozen=True)
class MobileStack:
    """A detected mobile project."""

    framework: str
    platforms: tuple[MobilePlatform, ...]
    project_dir: str
    commands: dict[MobilePlatform, PlatformCommands] = field(default_factory=dict)
    evidence: tuple[str, ...] = ()
    package_id: str = ""
    notes: str = ""

    @property
    def is_cross_platform(self) -> bool:
        return len(self.platforms) > 1

    def commands_for(self, platform: MobilePlatform) -> PlatformCommands:
        return self.commands.get(platform, PlatformCommands())

    def to_dict(self) -> dict:
        return {
            "framework": self.framework,
            "platforms": list(self.platforms),
            "projectDir": self.project_dir,
            "packageId": self.package_id,
            "evidence": list(self.evidence),
            "notes": self.notes,
            "isCrossPlatform": self.is_cross_platform,
            "commands": {
                platform: {
                    "run": cmd.run,
                    "build": cmd.build,
                    "test": cmd.test,
                    "lint": cmd.lint,
                    "artifact": cmd.artifact,
                    "notes": cmd.notes,
                }
                for platform, cmd in self.commands.items()
            },
        }


def normalise_targets(targets: object) -> tuple[MobilePlatform, ...]:
    """Read a user-supplied target list into ``("android", "ios")`` order.

    Accepts a list, or the comma-separated string an environment variable
    carries. Unknown entries are dropped rather than raising: a typo in a
    per-task setting should cost the specialisation, never the build.
    """
    if targets is None:
        return ()
    if isinstance(targets, str):
        raw = re.split(r"[,\s;]+", targets)
    elif isinstance(targets, (list, tuple, set)):
        raw = [str(item) for item in targets]
    else:
        return ()

    aliases = {
        "android": ANDROID,
        "droid": ANDROID,
        "google": ANDROID,
        "play": ANDROID,
        "ios": IOS,
        "apple": IOS,
        "iphone": IOS,
        "ipados": IOS,
        "ipad": IOS,
    }
    seen: list[MobilePlatform] = []
    for entry in raw:
        platform = aliases.get(entry.strip().lower())
        if platform and platform not in seen:
            seen.append(platform)
    # Stable order regardless of how the caller wrote it, so two tasks with the
    # same targets produce the same prompt and the same cache key.
    return tuple(p for p in (ANDROID, IOS) if p in seen)


def _read(path: Path, limit: int = 200_000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:limit]
    except OSError:
        return ""


def _candidate_dirs(root: Path) -> list[Path]:
    """``root`` first, then the shallow subdirectories worth looking at."""
    dirs = [root]
    for depth in range(_MAX_DEPTH):
        frontier = dirs[len(dirs) - 1 :] if depth else [root]
        next_level: list[Path] = []
        for parent in frontier if depth else [root]:
            try:
                entries = sorted(p for p in parent.iterdir() if p.is_dir())
            except OSError:
                continue
            for entry in entries:
                if entry.name in _PRUNED or entry.name.startswith("."):
                    continue
                next_level.append(entry)
        if not next_level:
            break
        dirs.extend(next_level)
    # De-duplicate while keeping order; a symlinked monorepo can list twice.
    seen: set[str] = set()
    unique: list[Path] = []
    for path in dirs:
        key = str(path)
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _gradle_wrapper(directory: Path) -> str:
    """`./gradlew` where the wrapper exists, plain `gradle` otherwise.

    A project with a wrapper and a machine with a different Gradle installed is
    the common case, and using the machine's is how you get a build failure that
    reads like a source error.
    """
    if (directory / "gradlew").exists() or (directory / "gradlew.bat").exists():
        return "./gradlew"
    return "gradle"


def _android_package_id(directory: Path) -> str:
    for name in (
        "app/build.gradle.kts",
        "app/build.gradle",
        "build.gradle.kts",
        "build.gradle",
    ):
        content = _read(directory / name)
        if not content:
            continue
        match = re.search(
            r"""applicationId\s*(?:=\s*)?["']([A-Za-z0-9_.]+)["']""", content
        )
        if match:
            return match.group(1)
    manifest = _read(directory / "app/src/main/AndroidManifest.xml")
    match = re.search(r'package\s*=\s*"([A-Za-z0-9_.]+)"', manifest)
    return match.group(1) if match else ""


def _detect_android_native(directory: Path) -> MobileStack | None:
    gradle_files = [
        directory / "settings.gradle.kts",
        directory / "settings.gradle",
        directory / "build.gradle.kts",
        directory / "build.gradle",
    ]
    present = [f for f in gradle_files if f.exists()]
    if not present:
        return None

    manifests = [
        directory / "app/src/main/AndroidManifest.xml",
        directory / "src/main/AndroidManifest.xml",
    ]
    text = "\n".join(_read(f) for f in present)
    declares_app = "com.android.application" in text or any(
        m.exists() for m in manifests
    )
    if not declares_app:
        return None

    gradle = _gradle_wrapper(directory)
    module = "app" if (directory / "app").is_dir() else ""
    prefix = f":{module}" if module else ""
    return MobileStack(
        framework="android-native",
        platforms=(ANDROID,),
        project_dir=str(directory),
        package_id=_android_package_id(directory),
        evidence=tuple(f.name for f in present)
        + tuple(m.name for m in manifests if m.exists()),
        commands={
            ANDROID: PlatformCommands(
                run=f"{gradle} {prefix}:installDebug".replace("::", ":"),
                build=f"{gradle} {prefix}:assembleDebug".replace("::", ":"),
                test=f"{gradle} {prefix}:testDebugUnitTest".replace("::", ":"),
                lint=f"{gradle} {prefix}:lintDebug".replace("::", ":"),
                artifact=f"{module or 'app'}/build/outputs/apk/debug/*.apk",
                notes=(
                    "installDebug puts the APK on the booted device but does not "
                    "start it; launch with `adb shell monkey -p <applicationId> "
                    "-c android.intent.category.LAUNCHER 1`. Instrumented tests "
                    "(connectedAndroidTest) need a running device, unit tests do not."
                ),
            )
        },
        notes="Gradle-built native Android application.",
    )


def _detect_ios_native(directory: Path) -> MobileStack | None:
    try:
        entries = list(directory.iterdir())
    except OSError:
        return None

    workspaces = [p for p in entries if p.suffix == ".xcworkspace"]
    projects = [p for p in entries if p.suffix == ".xcodeproj"]
    package_swift = directory / "Package.swift"
    swift_ios_package = package_swift.exists() and ".iOS(" in _read(package_swift)
    if not (workspaces or projects or swift_ios_package):
        return None

    if workspaces:
        container = f'-workspace "{workspaces[0].name}"'
        scheme = workspaces[0].stem
    elif projects:
        container = f'-project "{projects[0].name}"'
        scheme = projects[0].stem
    else:
        container = ""
        scheme = directory.name

    destination = "-destination 'platform=iOS Simulator,name=iPhone 16'"
    build = " ".join(
        part
        for part in (
            "xcodebuild",
            container,
            f'-scheme "{scheme}"',
            destination,
            "build",
        )
        if part
    )
    test = " ".join(
        part
        for part in (
            "xcodebuild",
            container,
            f'-scheme "{scheme}"',
            destination,
            "test",
        )
        if part
    )
    return MobileStack(
        framework="ios-native",
        platforms=(IOS,),
        project_dir=str(directory),
        package_id="",
        evidence=tuple(p.name for p in (*workspaces, *projects) if p)
        or ("Package.swift",),
        commands={
            IOS: PlatformCommands(
                run=build,
                build=build,
                test=test,
                lint="swiftlint lint --quiet",
                artifact="build/Build/Products/Debug-iphonesimulator/*.app",
                notes=(
                    "Requires macOS with Xcode: xcodebuild does not exist elsewhere, "
                    "and no amount of retrying changes that. Prefer the .xcworkspace "
                    "over the .xcodeproj whenever CocoaPods is in play — building the "
                    "project alone omits the Pods target. Install a built .app on a "
                    "booted simulator with `xcrun simctl install booted <path>`."
                ),
            )
        },
        notes="Xcode-built native iOS application.",
    )


def _detect_flutter(directory: Path) -> MobileStack | None:
    pubspec = directory / "pubspec.yaml"
    content = _read(pubspec)
    if not content or "flutter" not in content:
        return None

    platforms: list[MobilePlatform] = []
    if (directory / "android").is_dir():
        platforms.append(ANDROID)
    if (directory / "ios").is_dir():
        platforms.append(IOS)
    if not platforms:
        # `flutter create` scaffolds both; a pubspec depending on flutter with
        # neither folder is a package, not an application.
        return None

    commands = {
        ANDROID: PlatformCommands(
            run="flutter run -d android",
            build="flutter build apk --debug",
            test="flutter test",
            lint="flutter analyze",
            artifact="build/app/outputs/flutter-apk/app-debug.apk",
            notes="`flutter devices` lists what -d can target.",
        ),
        IOS: PlatformCommands(
            run="flutter run -d ios",
            build="flutter build ios --simulator --debug",
            test="flutter test",
            lint="flutter analyze",
            artifact="build/ios/iphonesimulator/Runner.app",
            notes=(
                "macOS only. `--simulator` skips code signing; a device build "
                "without a provisioning profile fails at the very end, after the "
                "whole compile."
            ),
        ),
    }
    return MobileStack(
        framework="flutter",
        platforms=tuple(platforms),
        project_dir=str(directory),
        evidence=("pubspec.yaml",),
        commands={p: commands[p] for p in platforms},
        notes="Flutter application; one Dart tree, both platforms.",
    )


def _package_json(directory: Path) -> dict:
    try:
        return json.loads(_read(directory / "package.json") or "{}")
    except (json.JSONDecodeError, ValueError):
        return {}


def _detect_react_native(directory: Path) -> MobileStack | None:
    pkg = _package_json(directory)
    if not pkg:
        return None
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    if "expo" in deps:
        return MobileStack(
            framework="expo",
            platforms=(ANDROID, IOS),
            project_dir=str(directory),
            evidence=("package.json (expo)",),
            commands={
                ANDROID: PlatformCommands(
                    run="npx expo run:android",
                    build="npx expo export --platform android",
                    test="npx jest",
                    lint="npx eslint .",
                    notes="`npx expo start --android` opens Expo Go instead of a native build.",
                ),
                IOS: PlatformCommands(
                    run="npx expo run:ios",
                    build="npx expo export --platform ios",
                    test="npx jest",
                    lint="npx eslint .",
                    notes="macOS only for run:ios. EAS Build is the remote alternative.",
                ),
            },
            notes="Expo-managed React Native application.",
        )
    if "react-native" not in deps:
        return None

    platforms: list[MobilePlatform] = []
    if (directory / "android").is_dir():
        platforms.append(ANDROID)
    if (directory / "ios").is_dir():
        platforms.append(IOS)
    if not platforms:
        return None

    commands = {
        ANDROID: PlatformCommands(
            run="npx react-native run-android",
            build="cd android && ./gradlew assembleDebug",
            test="npx jest",
            lint="npx eslint .",
            artifact="android/app/build/outputs/apk/debug/app-debug.apk",
            notes="Metro must be running; run-android starts it unless one is already bound to 8081.",
        ),
        IOS: PlatformCommands(
            run="npx react-native run-ios",
            build="cd ios && xcodebuild -workspace *.xcworkspace -scheme <Scheme> build",
            test="npx jest",
            lint="npx eslint .",
            notes="macOS only. Run `cd ios && pod install` after any native dependency changes.",
        ),
    }
    return MobileStack(
        framework="react-native",
        platforms=tuple(platforms),
        project_dir=str(directory),
        evidence=("package.json (react-native)",),
        commands={p: commands[p] for p in platforms},
        notes="Bare React Native application.",
    )


def _detect_capacitor(directory: Path) -> MobileStack | None:
    pkg = _package_json(directory)
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    has_config = any(
        (directory / name).exists()
        for name in (
            "capacitor.config.ts",
            "capacitor.config.json",
            "capacitor.config.js",
        )
    )
    if not (has_config or any(d.startswith("@capacitor/") for d in deps)):
        return None

    platforms: list[MobilePlatform] = []
    if (directory / "android").is_dir():
        platforms.append(ANDROID)
    if (directory / "ios").is_dir():
        platforms.append(IOS)
    if not platforms:
        platforms = [ANDROID, IOS]

    commands = {
        ANDROID: PlatformCommands(
            run="npx cap run android",
            build="npx cap sync android && npx cap build android",
            test="npx vitest run",
            lint="npx eslint .",
            notes="`cap sync` copies the built web assets; running without it previews the previous build.",
        ),
        IOS: PlatformCommands(
            run="npx cap run ios",
            build="npx cap sync ios && npx cap build ios",
            test="npx vitest run",
            lint="npx eslint .",
            notes="macOS only. Same sync rule as Android.",
        ),
    }
    return MobileStack(
        framework="capacitor",
        platforms=tuple(platforms),
        project_dir=str(directory),
        evidence=("capacitor.config.*",),
        commands={p: commands[p] for p in platforms},
        notes="Capacitor application — a web build wrapped in a native shell.",
    )


def _detect_maui(directory: Path) -> MobileStack | None:
    try:
        projects = sorted(directory.glob("*.csproj")) + sorted(
            directory.glob("*/*.csproj")
        )
    except OSError:
        return None

    for csproj in projects:
        content = _read(csproj)
        if not content:
            continue
        lowered = content.lower()
        if "<usemaui>true</usemaui>" not in lowered and "-android" not in lowered:
            continue

        platforms: list[MobilePlatform] = []
        frameworks = re.search(
            r"<TargetFrameworks?>([^<]+)</TargetFrameworks?>", content, re.IGNORECASE
        )
        tfms = frameworks.group(1) if frameworks else ""
        android_tfm = next(
            (t.strip() for t in tfms.split(";") if "-android" in t), "net10.0-android"
        )
        ios_tfm = next(
            (t.strip() for t in tfms.split(";") if "-ios" in t), "net10.0-ios"
        )
        if "-android" in tfms:
            platforms.append(ANDROID)
        if "-ios" in tfms:
            platforms.append(IOS)
        if not platforms:
            platforms = [ANDROID]

        rel = csproj.name
        commands = {
            ANDROID: PlatformCommands(
                run=f'dotnet build "{rel}" -t:Run -f {android_tfm}',
                build=f'dotnet publish "{rel}" -f {android_tfm} -c Release',
                test="dotnet test --nologo",
                lint="dotnet format --verify-no-changes",
                artifact="bin/Release/**/*-Signed.apk",
                notes=(
                    "`-t:Run` deploys onto the first booted emulator; pass "
                    "`-p:AdbTarget=-s<serial>` to choose one. `dotnet test` on a "
                    "MAUI head fails — put unit tests in a plain net10.0 project."
                ),
            ),
            IOS: PlatformCommands(
                run=f'dotnet build "{rel}" -t:Run -f {ios_tfm} -p:_DeviceName=:v2:udid=<simulator-udid>',
                build=f'dotnet publish "{rel}" -f {ios_tfm} -c Release',
                test="dotnet test --nologo",
                lint="dotnet format --verify-no-changes",
                notes=(
                    "macOS with Xcode only. The simulator udid comes from "
                    "`xcrun simctl list devices available`."
                ),
            ),
        }
        return MobileStack(
            framework="dotnet-maui",
            platforms=tuple(platforms),
            project_dir=str(directory),
            evidence=(rel,),
            commands={p: commands[p] for p in platforms},
            notes=".NET MAUI application; one C# tree, both platforms.",
        )
    return None


def _detect_kmp(directory: Path) -> MobileStack | None:
    settings = _read(directory / "settings.gradle.kts") + _read(
        directory / "settings.gradle"
    )
    build = _read(directory / "build.gradle.kts") + _read(directory / "build.gradle")
    text = settings + build
    if "multiplatform" not in text and "kotlin-multiplatform" not in text:
        return None
    has_ios = (
        (directory / "iosApp").is_dir()
        or "iosArm64" in text
        or "iosSimulatorArm64" in text
    )
    has_android = (directory / "androidApp").is_dir() or "com.android." in text
    if not (has_ios or has_android):
        return None

    gradle = _gradle_wrapper(directory)
    platforms = tuple(
        p for p, present in ((ANDROID, has_android), (IOS, has_ios)) if present
    )
    commands = {
        ANDROID: PlatformCommands(
            run=f"{gradle} :androidApp:installDebug",
            build=f"{gradle} :androidApp:assembleDebug",
            test=f"{gradle} :shared:testDebugUnitTest",
            lint=f"{gradle} ktlintCheck",
            notes="The shared module's common tests run on the JVM; the Android head has its own.",
        ),
        IOS: PlatformCommands(
            run="xcodebuild -project iosApp/iosApp.xcodeproj -scheme iosApp -destination 'platform=iOS Simulator,name=iPhone 16' build",
            build=f"{gradle} :shared:linkDebugFrameworkIosSimulatorArm64",
            test=f"{gradle} :shared:iosSimulatorArm64Test",
            lint=f"{gradle} ktlintCheck",
            notes=(
                "macOS only. Build the shared framework before opening the Xcode "
                "project, or the iOS target links against a stale one."
            ),
        ),
    }
    return MobileStack(
        framework="kotlin-multiplatform",
        platforms=platforms,
        project_dir=str(directory),
        evidence=("settings.gradle[.kts] (multiplatform)",),
        commands={p: commands[p] for p in platforms},
        notes="Kotlin Multiplatform Mobile; shared Kotlin, per-platform heads.",
    )


# Order matters. A Flutter or React Native project contains a full `android/`
# Gradle project and an `ios/` Xcode project, so the native detectors would
# both fire on it and report the wrapper rather than the thing being written.
# The cross-platform frameworks therefore go first, and the native detectors
# are the fallback.
_DETECTORS = (
    _detect_flutter,
    _detect_react_native,
    _detect_maui,
    _detect_capacitor,
    _detect_kmp,
    _detect_android_native,
    _detect_ios_native,
)


def detect_stack(project_dir: Path | str | None) -> MobileStack | None:
    """The mobile stack of ``project_dir``, or ``None`` when it is not one.

    Looks at the root first, then shallow subdirectories, so a monorepo whose
    phone app lives in `apps/mobile/` is found without the caller having to
    know that. Never raises: an unreadable directory is "not a mobile project",
    which is the same answer the caller would act on anyway.
    """
    if not project_dir:
        return None
    root = Path(project_dir)
    if not root.is_dir():
        return None

    for directory in _candidate_dirs(root):
        for detector in _DETECTORS:
            try:
                stack = detector(directory)
            except Exception:  # noqa: BLE001 - detection never breaks a build
                continue
            if stack:
                return stack
    return None


def is_mobile_project(project_dir: Path | str | None) -> bool:
    return detect_stack(project_dir) is not None
