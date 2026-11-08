"""What the Kanban offers when a task targets a phone and the project has no app yet.

The "Mobile platforms" box of the task form used to show the same two
checkboxes on every project. On a Flutter repository they narrow the build to
Android or iOS; on a .NET Web API they meant nothing, and an agent asked for
"the Android app" of an API had no app to build and no rule for creating one.

So the form asks one question first, :func:`mobile_profile`:

* the project **has** a phone app (``mobile.stacks.detect_stack``): the box
  stays as it was, and says which framework was found;
* it **has none**: the box explains that checking a platform first adds setup
  tasks to the board (install the framework, create the app, prepare each
  platform checked), and the task waits for them. Which framework is proposed
  follows the stacks already in the repository, so a C# team is offered
  .NET MAUI and a React team Expo, never "Flutter for everyone".

Everything here reads files and nothing else: no model, no network, no
toolchain call, so it is cheap enough to run each time the form opens, on the
computer and on a server alike (``shared_board.api``).

The commands are written for the agents that run the setup tasks, in English
like every other prompt fragment; the task text around them is translated by
the app.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .stacks import ANDROID, IOS, MobilePlatform, detect_stack

__all__ = [
    "FRAMEWORKS",
    "BootstrapFramework",
    "host_stacks",
    "mobile_dir_for",
    "mobile_profile",
    "rank_frameworks",
]

BOTH: tuple[MobilePlatform, ...] = (ANDROID, IOS)

# Same pruning as the mobile detector: build output and vendored trees say
# nothing about what the team writes, and walking them is what makes a scan slow.
_PRUNED = {
    "node_modules",
    "build",
    "dist",
    "out",
    "DerivedData",
    "Pods",
    ".git",
    ".gradle",
    ".dart_tool",
    "bin",
    "obj",
    "vendor",
    "target",
    ".venv",
    "venv",
    "__pycache__",
}

#: Root and two levels below it: `apps/api/`, `src/Web/`, `backend/`. A
#: monorepo puts its services there; ``project.stack.detect_project_stack``
#: reads the root only, which misses most of them.
_MAX_DEPTH = 2
_MAX_DIRS = 400


@dataclass(frozen=True)
class BootstrapFramework:
    """A phone framework the setup tasks can install and scaffold."""

    id: str
    label: str
    platforms: tuple[MobilePlatform, ...]
    #: Toolchain the machine needs, in the order an agent installs it.
    install: tuple[str, ...]
    #: Creates the app in ``{dir}`` (named ``{name}``) for ``{platforms}``.
    scaffold: tuple[str, ...]
    #: Per platform: what "the platform is ready" means for this framework.
    platform_setup: dict[MobilePlatform, tuple[str, ...]]
    docs: str
    notes: str = ""

    def to_dict(self, directory: str, name: str) -> dict:
        def fill(lines: tuple[str, ...]) -> list[str]:
            return [
                line.replace("{dir}", directory)
                .replace("{name}", name)
                .replace("{snake}", _snake(name))
                for line in lines
            ]

        return {
            "id": self.id,
            "label": self.label,
            "platforms": list(self.platforms),
            "install": fill(self.install),
            "scaffold": fill(self.scaffold),
            "platformSetup": {
                platform: fill(lines) for platform, lines in self.platform_setup.items()
            },
            "docs": self.docs,
            "notes": self.notes,
        }


_ANDROID_SDK = (
    "Android SDK + platform-tools (adb) + an emulator image, via Android Studio "
    "or `sdkmanager`; JDK 17 or newer"
)
_XCODE = "Xcode with the iOS simulator runtime (macOS only), and CocoaPods when the framework uses it"

FRAMEWORKS: dict[str, BootstrapFramework] = {
    fw.id: fw
    for fw in (
        BootstrapFramework(
            id="flutter",
            label="Flutter",
            platforms=BOTH,
            install=(
                "Flutter SDK (stable channel), then `flutter doctor` until the targeted platforms are green",
                _ANDROID_SDK,
                _XCODE,
            ),
            scaffold=(
                "flutter create --org com.example --project-name {snake} --platforms={platforms} {dir}",
            ),
            platform_setup={
                ANDROID: (
                    "Set the applicationId in {dir}/android/app/build.gradle(.kts)",
                    "flutter build apk --debug",
                ),
                IOS: (
                    "Set the bundle identifier in {dir}/ios/Runner.xcodeproj",
                    "flutter build ios --simulator --debug",
                ),
            },
            docs="https://docs.flutter.dev/get-started/install",
        ),
        BootstrapFramework(
            id="expo",
            label="React Native (Expo)",
            platforms=BOTH,
            install=(
                "Node.js LTS and the package manager the repository already uses",
                _ANDROID_SDK,
                _XCODE,
            ),
            scaffold=("npx create-expo-app@latest {dir} --template blank-typescript",),
            platform_setup={
                ANDROID: (
                    "Set `expo.android.package` in {dir}/app.json",
                    "npx expo prebuild --platform android, then npx expo run:android",
                ),
                IOS: (
                    "Set `expo.ios.bundleIdentifier` in {dir}/app.json",
                    "npx expo prebuild --platform ios, then npx expo run:ios",
                ),
            },
            docs="https://docs.expo.dev/get-started/create-a-project/",
            notes="Share types and API clients with the web code through the workspace instead of copying them.",
        ),
        BootstrapFramework(
            id="dotnet-maui",
            label=".NET MAUI",
            platforms=BOTH,
            install=(
                ".NET SDK matching the repository's global.json or target framework",
                "dotnet workload install maui",
                _ANDROID_SDK,
                _XCODE,
            ),
            scaffold=(
                "dotnet new maui -n {name} -o {dir}",
                "Add the new project to the solution (dotnet sln add) when the repository has one",
            ),
            platform_setup={
                ANDROID: (
                    "Keep the net*-android target framework in the .csproj and set ApplicationId",
                    "dotnet build {dir} -f <net*-android>",
                ),
                IOS: (
                    "Keep the net*-ios target framework in the .csproj and set ApplicationId",
                    "dotnet build {dir} -f <net*-ios>",
                ),
            },
            docs="https://learn.microsoft.com/dotnet/maui/get-started/installation",
            notes="Reference the existing contracts/DTO project instead of duplicating models.",
        ),
        BootstrapFramework(
            id="capacitor",
            label="Capacitor",
            platforms=BOTH,
            install=(
                "Node.js LTS and the package manager the repository already uses",
                _ANDROID_SDK,
                _XCODE,
            ),
            scaffold=(
                "In the existing web app: install @capacitor/core and @capacitor/cli",
                "npx cap init {name} com.example.{name} --web-dir <the web build output>",
            ),
            platform_setup={
                ANDROID: (
                    "npm install @capacitor/android",
                    "npx cap add android",
                    "npx cap sync android",
                ),
                IOS: (
                    "npm install @capacitor/ios",
                    "npx cap add ios",
                    "npx cap sync ios",
                ),
            },
            docs="https://capacitorjs.com/docs/getting-started",
            notes="Capacitor wraps the existing web front end: no second UI code base.",
        ),
        BootstrapFramework(
            id="kotlin-multiplatform",
            label="Kotlin Multiplatform",
            platforms=BOTH,
            install=("JDK 17 or newer", _ANDROID_SDK, _XCODE),
            scaffold=(
                "Generate a Compose Multiplatform project (kmp.jetbrains.com template) into {dir}",
                "Commit the Gradle wrapper; `./gradlew tasks` must run",
            ),
            platform_setup={
                ANDROID: (
                    "Set applicationId in the androidApp module",
                    "./gradlew :composeApp:assembleDebug",
                ),
                IOS: (
                    "Set the bundle identifier in iosApp/",
                    "Build the iosApp scheme with xcodebuild for a simulator",
                ),
            },
            docs="https://kotlinlang.org/docs/multiplatform/quickstart.html",
        ),
        BootstrapFramework(
            id="android-native",
            label="Android (Kotlin)",
            platforms=(ANDROID,),
            install=(_ANDROID_SDK,),
            scaffold=(
                "Create an Android application module (Kotlin, Jetpack Compose) in {dir} with its Gradle wrapper",
            ),
            platform_setup={ANDROID: ("Set applicationId", "./gradlew assembleDebug")},
            docs="https://developer.android.com/studio/projects/create-project",
        ),
        BootstrapFramework(
            id="ios-native",
            label="iOS (Swift)",
            platforms=(IOS,),
            install=(_XCODE,),
            scaffold=(
                "Create a SwiftUI iOS app in {dir} (an Xcode project, or XcodeGen's project.yml committed with it)",
            ),
            platform_setup={
                IOS: (
                    "Set the bundle identifier",
                    "xcodebuild -scheme {name} -sdk iphonesimulator build",
                )
            },
            docs="https://developer.apple.com/documentation/xcode/creating-an-xcode-project-for-an-app",
        ),
    )
}

#: What each host stack suggests, best first. The point is to stay in the
#: language the team already writes: shared models, one package manager, one
#: set of habits. A stack with no phone framework of its own (Python, Go,
#: Rust, PHP, Ruby, Elixir…) talks to its app over HTTP, and Flutter is the
#: neutral default for that.
_SUGGESTIONS: dict[str, tuple[str, ...]] = {
    "dart": ("flutter",),
    "dotnet": ("dotnet-maui", "flutter"),
    "react": ("expo", "capacitor"),
    "web-spa": ("capacitor", "expo"),
    "javascript": ("expo", "capacitor"),
    "jvm": ("kotlin-multiplatform", "android-native"),
    "swift": ("ios-native", "flutter"),
}
_DEFAULT_ORDER = (
    "flutter",
    "expo",
    "dotnet-maui",
    "capacitor",
    "kotlin-multiplatform",
    "android-native",
    "ios-native",
)

_REACT_DEPS = ("react", "next", "react-dom", "@remix-run/react", "gatsby")
_SPA_DEPS = (
    "@angular/core",
    "vue",
    "nuxt",
    "svelte",
    "@sveltejs/kit",
    "@ionic/core",
    "solid-js",
)

# Manifest → host stack. Globs are matched in the directory only.
_MANIFESTS: tuple[tuple[str, str], ...] = (
    ("pubspec.yaml", "dart"),
    ("*.sln", "dotnet"),
    ("*.slnx", "dotnet"),
    ("*.csproj", "dotnet"),
    ("*.fsproj", "dotnet"),
    ("pom.xml", "jvm"),
    ("build.gradle", "jvm"),
    ("build.gradle.kts", "jvm"),
    ("Package.swift", "swift"),
    ("go.mod", "go"),
    ("Cargo.toml", "rust"),
    ("pyproject.toml", "python"),
    ("requirements.txt", "python"),
    ("composer.json", "php"),
    ("Gemfile", "ruby"),
    ("mix.exs", "elixir"),
)


def _shallow_dirs(root: Path) -> list[Path]:
    dirs = [root]
    frontier = [root]
    for _ in range(_MAX_DEPTH):
        nxt: list[Path] = []
        for parent in frontier:
            try:
                children = sorted(p for p in parent.iterdir() if p.is_dir())
            except OSError:
                continue
            for child in children:
                if child.name in _PRUNED or child.name.startswith("."):
                    continue
                nxt.append(child)
        dirs.extend(nxt)
        frontier = nxt
        if len(dirs) >= _MAX_DIRS:
            break
    return dirs[:_MAX_DIRS]


def _package_stacks(directory: Path) -> set[str]:
    try:
        data = json.loads((directory / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if not isinstance(data, dict):
        return set()
    deps: dict = {}
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        value = data.get(key)
        if isinstance(value, dict):
            deps.update(value)
    found = {"javascript"}
    if any(dep in deps for dep in _REACT_DEPS):
        found.add("react")
    if any(dep in deps for dep in _SPA_DEPS):
        found.add("web-spa")
    return found


def host_stacks(project_dir: Path | str) -> list[str]:
    """The stacks the repository is written in, by how close to the root they sit.

    ``dotnet``, ``react``, ``web-spa`` (Angular, Vue, Nuxt, Svelte, Ionic…),
    ``javascript``, ``jvm``, ``swift``, ``dart``, ``go``, ``rust``,
    ``python``, ``php``, ``ruby``, ``elixir``. Empty for an empty folder.
    """
    root = Path(project_dir)
    if not root.is_dir():
        return []
    found: list[str] = []
    for directory in _shallow_dirs(root):
        hits: set[str] = set()
        if (directory / "package.json").is_file():
            hits |= _package_stacks(directory)
        for pattern, stack in _MANIFESTS:
            if stack in hits:
                continue
            if "*" in pattern:
                if next(directory.glob(pattern), None) is not None:
                    hits.add(stack)
            elif (directory / pattern).is_file():
                hits.add(stack)
        for stack in sorted(hits, key=_stack_weight):
            if stack not in found:
                found.append(stack)
    return found


def _stack_weight(stack: str) -> int:
    # Inside one directory, the more specific answer first: a React app is
    # also "javascript", and the suggestion should follow React.
    order = ("dart", "dotnet", "react", "web-spa", "jvm", "swift")
    return order.index(stack) if stack in order else len(order)


def rank_frameworks(stacks: list[str]) -> list[str]:
    """Every framework, the ones the host stacks suggest first."""
    ranked: list[str] = []
    for stack in stacks:
        for framework in _SUGGESTIONS.get(stack, ()):
            if framework not in ranked:
                ranked.append(framework)
    for framework in _DEFAULT_ORDER:
        if framework not in ranked:
            ranked.append(framework)
    return ranked


def mobile_dir_for(project_dir: Path | str) -> str:
    """Where a new app goes: next to the other apps of a monorepo, else ``mobile/``."""
    root = Path(project_dir)
    base = "apps/mobile" if (root / "apps").is_dir() else "mobile"
    candidate = base
    index = 2
    while (root / candidate).exists():
        candidate = f"{base}-app" if index == 2 else f"{base}-app-{index}"
        index += 1
    return candidate


def _snake(name: str) -> str:
    """``WorkPilotMobile`` → ``work_pilot_mobile``: Dart package names."""
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def _app_name(project_dir: Path) -> str:
    """A name every framework accepts: letters and digits, starting with a letter."""
    words = re.findall(r"[A-Za-z0-9]+", project_dir.resolve().name)
    name = "".join(word[:1].upper() + word[1:] for word in words) or "App"
    if not name[0].isalpha():
        name = f"App{name}"
    return f"{name}Mobile"


def mobile_profile(project_dir: Path | str) -> dict:
    """What the task form needs to draw the "Mobile platforms" box.

    ``isMobile`` with ``stack`` when the project already has an app;
    otherwise ``hostStacks``, the ranked ``frameworks`` the setup tasks can
    install, and the ``mobileDir``/``appName`` they would create.
    """
    root = Path(project_dir)
    if not root.is_dir():
        return {"success": False, "isMobile": False, "error": "Directory not found"}
    stack = detect_stack(root)
    if stack is not None:
        return {
            "success": True,
            "isMobile": True,
            "stack": {"framework": stack.framework, "platforms": list(stack.platforms)},
        }
    stacks = host_stacks(root)
    directory = mobile_dir_for(root)
    name = _app_name(root)
    return {
        "success": True,
        "isMobile": False,
        "hostStacks": stacks,
        "mobileDir": directory,
        "appName": name,
        "frameworks": [
            FRAMEWORKS[framework].to_dict(directory, name)
            for framework in rank_frameworks(stacks)
        ],
    }
