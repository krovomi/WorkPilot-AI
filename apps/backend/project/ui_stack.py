"""Which UI toolkits a project uses, and which of upstream's stack guides fits.

Nothing here detects anything the repository already answers.
`project.framework_detector` reads `package.json`, `composer.json` and
`pubspec.yaml`, and `mobile.detect_stack` knows the phone toolkits. What neither
knew is the .NET desktop side — WPF, WinUI, UWP, Avalonia, Uno, Blazor — and
JavaFX, so that is the only detection written here, from the project files
those toolkits declare themselves in.

Two refinements on top: the detectors are run on the root *and* on the shallow
directories a monorepo keeps its apps in (`apps/web/`, `frontend/`), because
`FrameworkDetector` reads one `package.json` at the root; and each detection
keeps the directory it was found in, so a task whose UI files sit under
`apps/admin/` gets that app's guide rather than the first one found.

A toolkit with no upstream guide (Blazor, .NET MAUI) is reported with
``guide=None``. "No stack guide" is an answer; the nearest wrong guide is not.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

__all__ = ["UiToolkit", "UiStack", "detect_ui_stack"]

_SKIP_DIRS = {
    ".git",
    "node_modules",
    "bin",
    "obj",
    "dist",
    "build",
    "out",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".workpilot",
    ".worktrees",
}

#: Where monorepos keep their apps. Their children are looked at too.
_CONTAINERS = ("apps", "packages", "src", "clients", "frontend", "web", "ui")

#: `FrameworkDetector` names -> upstream guide, most specific first.
_NODE_GUIDES: tuple[tuple[str, str], ...] = (
    ("nextjs", "nextjs"),
    ("nuxt", "nuxtjs"),
    ("angular", "angular"),
    ("svelte", "svelte"),
    ("astro", "astro"),
    ("react-native", "react-native"),
    ("expo", "react-native"),
    ("vue", "vue"),
    ("react", "react"),
    ("laravel", "laravel"),
    ("flutter", "flutter"),
)

_UI_FRAMEWORKS = {name for name, _ in _NODE_GUIDES} | {
    "remix",
    "gatsby",
    "electron",
    "tauri",
    "capacitor",
}

#: `mobile.detect_stack().framework` -> upstream guide.
_MOBILE_GUIDES = {
    "flutter": "flutter",
    "react-native": "react-native",
    "expo": "react-native",
    "ios-native": "swiftui",
    "android-native": "jetpack-compose",
    "kotlin-multiplatform": "jetpack-compose",
    "capacitor": None,
    "dotnet-maui": None,
}

#: .NET project markers -> (toolkit, guide). Read from the csproj text.
_DOTNET_MARKERS: tuple[tuple[re.Pattern[str], str, str | None], ...] = (
    (re.compile(r"<UseWPF>\s*true", re.I), "wpf", "wpf"),
    (re.compile(r"<UseWinUI>\s*true|Microsoft\.WindowsAppSDK", re.I), "winui", "winui"),
    (re.compile(r"Uno\.Sdk|Uno\.WinUI", re.I), "uno", "uno"),
    (re.compile(r"Include=\"Avalonia\b", re.I), "avalonia", "avalonia"),
    (re.compile(r"<TargetPlatformIdentifier>\s*UAP", re.I), "uwp", "uwp"),
    (re.compile(r"<UseMaui>\s*true", re.I), "maui", None),
    (
        re.compile(
            r"Microsoft\.NET\.Sdk\.BlazorWebAssembly|Microsoft\.AspNetCore\.Components\.Web",
            re.I,
        ),
        "blazor",
        None,
    ),
)


@dataclass(frozen=True)
class UiToolkit:
    name: str
    guide: str | None
    root: str  # posix, relative to the project; "." for the root
    evidence: str


@dataclass
class UiStack:
    toolkits: list[UiToolkit] = field(default_factory=list)

    @property
    def has_ui(self) -> bool:
        return bool(self.toolkits)

    def guide_for(self, files: list[str] | None = None) -> UiToolkit | None:
        """The toolkit whose directory holds most of ``files``; else the first
        one with a guide; else the first one."""
        if not self.toolkits:
            return None
        if files:
            best: tuple[int, int, UiToolkit] | None = None
            for index, kit in enumerate(self.toolkits):
                prefix = "" if kit.root == "." else kit.root.rstrip("/") + "/"
                hits = sum(
                    1
                    for f in files
                    if str(f).replace("\\", "/").lstrip("./").startswith(prefix)
                )
                # Deeper roots are more specific; ties keep declaration order.
                score = (hits, len(prefix))
                if hits and (best is None or score > best[:2]):
                    best = (score[0], score[1], kit)
            if best is not None:
                return best[2]
        for kit in self.toolkits:
            if kit.guide:
                return kit
        return self.toolkits[0]

    def to_dict(self) -> dict[str, object]:
        return {"toolkits": [asdict(k) for k in self.toolkits]}


def _candidate_dirs(root: Path) -> list[Path]:
    out = [root]
    try:
        children = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return out
    for child in children:
        if child.name in _SKIP_DIRS or child.name.startswith("."):
            continue
        out.append(child)
        if child.name in _CONTAINERS:
            try:
                grand = sorted(p for p in child.iterdir() if p.is_dir())
            except OSError:
                continue
            out.extend(
                g
                for g in grand
                if g.name not in _SKIP_DIRS and not g.name.startswith(".")
            )
    return out


def _rel(path: Path, root: Path) -> str:
    try:
        rel = PurePosixPath(path.relative_to(root).as_posix())
    except ValueError:
        return "."
    text = str(rel)
    return text if text not in ("", ".") else "."


def _package_extras(directory: Path) -> list[tuple[str, str | None]]:
    """What `FrameworkDetector` does not name and a guide depends on."""
    try:
        pkg = json.loads((directory / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(pkg, dict):
        return []
    deps = {
        **(pkg.get("dependencies") or {}),
        **(pkg.get("devDependencies") or {}),
    }
    out: list[tuple[str, str | None]] = []
    if "@nuxt/ui" in deps:
        out.append(("nuxt-ui", "nuxt-ui"))
    if (directory / "components.json").is_file() and (
        "react" in deps or "next" in deps
    ):
        out.append(("shadcn", "shadcn"))
    if "three" in deps or "@react-three/fiber" in deps:
        out.append(("threejs", "threejs"))
    if "tailwindcss" in deps:
        out.append(("tailwind", "html-tailwind"))
    return out


def _node_toolkits(directory: Path, root: Path) -> list[UiToolkit]:
    try:
        from project.framework_detector import FrameworkDetector

        frameworks = FrameworkDetector(directory).detect_all()
    except Exception:  # noqa: BLE001 - detection never breaks a build
        frameworks = []
    rel = _rel(directory, root)
    kits: list[UiToolkit] = []
    extras = _package_extras(directory)
    # Specific extras first: a shadcn app is a React app whose guide is shadcn's.
    for name, guide in extras:
        if name in ("nuxt-ui", "shadcn"):
            kits.append(UiToolkit(name, guide, rel, "package.json"))
    for name, guide in _NODE_GUIDES:
        if name in frameworks:
            kits.append(UiToolkit(name, guide, rel, "package.json / framework files"))
            break
    else:
        for name in frameworks:
            if name in _UI_FRAMEWORKS:
                kits.append(UiToolkit(name, None, rel, "package.json"))
                break
    for name, guide in extras:
        if name == "threejs":
            kits.append(UiToolkit(name, guide, rel, "package.json"))
        elif name == "tailwind" and not kits:
            kits.append(UiToolkit(name, guide, rel, "package.json"))
    return kits


def _dotnet_toolkits(directory: Path, root: Path) -> list[UiToolkit]:
    kits: list[UiToolkit] = []
    try:
        projects = sorted(directory.glob("*.csproj"))
    except OSError:
        return kits
    for project in projects:
        try:
            text = project.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for pattern, name, guide in _DOTNET_MARKERS:
            if pattern.search(text):
                kits.append(UiToolkit(name, guide, _rel(directory, root), project.name))
                break
    return kits


def _java_toolkits(directory: Path, root: Path) -> list[UiToolkit]:
    for name in ("pom.xml", "build.gradle", "build.gradle.kts"):
        try:
            text = (directory / name).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if "javafx" in text.lower():
            return [UiToolkit("javafx", "javafx", _rel(directory, root), name)]
    return []


def detect_ui_stack(project_dir: Path | str | None) -> UiStack:
    """Every UI toolkit found at the root and in the usual app directories."""
    stack = UiStack()
    if not project_dir:
        return stack
    root = Path(project_dir)
    if not root.is_dir():
        return stack

    seen: set[tuple[str, str]] = set()

    def add(kits: list[UiToolkit]) -> None:
        for kit in kits:
            key = (kit.name, kit.root)
            if key not in seen:
                seen.add(key)
                stack.toolkits.append(kit)

    for directory in _candidate_dirs(root):
        add(_node_toolkits(directory, root))
        add(_dotnet_toolkits(directory, root))
        add(_java_toolkits(directory, root))

    try:
        from mobile import detect_stack

        mobile = detect_stack(root)
    except Exception:  # noqa: BLE001
        mobile = None
    if mobile is not None:
        guide = _MOBILE_GUIDES.get(mobile.framework)
        mobile_root = _rel(Path(mobile.project_dir), root)
        add([UiToolkit(mobile.framework, guide, mobile_root, "mobile stack")])
    return stack
