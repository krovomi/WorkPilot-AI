"""What a project has built, to be read by REA: the shipped artifacts per stack.

The gate audits what the build left on disk; it never builds (a build runs the
project's code). A task worktree starts without build output, so what is found
here was produced during the task. Found by name, from a closed table of the
output locations of each stack, under a bounded walk that skips dependencies
and caches:

* desktop: an electron-builder or Tauri bundle (``*-unpacked/``, ``*.app``,
  ``*.AppImage``, ``*.dmg``, ``*.msi``, ``*.deb``, ``*.rpm``, ``*.exe`` under a
  release folder), a Flutter desktop bundle;
* mobile: ``*.apk``, ``*.aab``, ``*.ipa``;
* web: a build folder holding JavaScript (``dist/``, ``build/``, ``out/``,
  ``.next/``, ``.output/``, Blazor's ``wwwroot/_framework``), where shipped
  source maps live;
* .NET: a ``publish/`` folder under ``bin/``; Java and Kotlin: ``*.jar`` /
  ``*.war`` under ``target/`` or ``build/libs/``; Rust: the executables of
  ``target/release/``; Python: ``*.whl`` under ``dist/``; any ``*.nupkg``,
  ``*.vsix``, ``*.wasm`` under a build folder.

Nothing is followed through a symbolic link, and every path is resolved and
kept only when it stays inside the project.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from foundation.platform import is_windows

__all__ = ["MAX_ARTIFACTS", "Artifact", "find_artifacts"]

MAX_ARTIFACTS = 6
MAX_DEPTH = 8
MAX_ENTRIES = 50_000

_SKIP = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".workpilot",
        ".worktrees",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".gradle",
        ".dart_tool",
        ".pub-cache",
        ".terraform",
        "obj",
        "Pods",
        "vendor",
        ".cache",
        ".turbo",
        "coverage",
    }
)

#: Folders whose content is what a web build ships.
_WEB_BUILDS = frozenset({"dist", "build", "out", ".next", ".output"})
#: Folders a desktop or package build writes its bundles to.
_RELEASE_DIRS = frozenset({"dist", "release", "out", "build", "bundle", "make"})
_PACKAGE_SUFFIXES = {
    ".apk": "android",
    ".aab": "android",
    ".ipa": "ios",
    ".appimage": "desktop",
    ".dmg": "desktop",
    ".msi": "desktop",
    ".deb": "desktop",
    ".rpm": "desktop",
    ".nupkg": "dotnet",
    ".vsix": "extension",
    ".whl": "python",
    ".jar": "jvm",
    ".war": "jvm",
    ".wasm": "wasm",
}
_SCRIPT_SUFFIXES = (".js", ".mjs", ".cjs", ".map")


@dataclass(frozen=True)
class Artifact:
    path: Path
    """Absolute and resolved, inside the project."""
    kind: str
    """``desktop``, ``android``, ``ios``, ``web``, ``dotnet``, ``jvm``, ``rust``…"""

    def relative(self, project_dir: Path) -> str:
        try:
            return self.path.relative_to(project_dir).as_posix()
        except ValueError:
            return self.path.name


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _holds_scripts(folder: Path, limit: int = 2000) -> bool:
    seen = 0
    for _dirpath, _dirs, files in os.walk(folder):
        for name in files:
            seen += 1
            if name.endswith(_SCRIPT_SUFFIXES):
                return True
            if seen >= limit:
                return False
    return False


def _rust_executables(release: Path) -> list[Path]:
    found: list[Path] = []
    try:
        entries = list(release.iterdir())
    except OSError:
        return found
    for entry in entries:
        if entry.is_symlink() or not entry.is_file():
            continue
        suffix = entry.suffix.lower()
        # Windows reports every file as executable: only an .exe counts there.
        if suffix == ".exe" or (
            not suffix and not is_windows() and os.access(entry, os.X_OK)
        ):
            found.append(entry)
    return found


def _classify_dir(path: Path, parent: Path) -> str | None:
    name = path.name
    lower = name.lower()
    if lower.endswith("-unpacked") or (lower.endswith(".app") and path.is_dir()):
        return "desktop"
    if lower == "publish" and "bin" in {p.name.lower() for p in path.parents}:
        return "dotnet"
    if lower == "_framework" and parent.name.lower() == "wwwroot":
        return "web"
    if lower in _WEB_BUILDS and _holds_scripts(path):
        return "web"
    return None


def _classify_file(path: Path, parent: Path) -> str | None:
    lower = path.name.lower()
    suffix = path.suffix.lower()
    kind = _PACKAGE_SUFFIXES.get(suffix)
    if kind == "jvm":
        parents = {p.name.lower() for p in path.parents}
        return kind if "target" in parents or "libs" in parents else None
    if kind == "python":
        return kind if parent.name.lower() == "dist" else None
    if kind in ("wasm", "dotnet", "extension"):
        parents = {p.name.lower() for p in path.parents}
        return kind if parents & (_RELEASE_DIRS | {"bin", "target", "pkg"}) else None
    if kind:
        return kind
    if lower.endswith(".exe") and parent.name.lower() in _RELEASE_DIRS:
        return "desktop"
    return None


def find_artifacts(
    project_dir: Path | str, *, limit: int = MAX_ARTIFACTS
) -> list[Artifact]:
    """The shipped artifacts of ``project_dir``, nearest first, at most ``limit``."""
    root = Path(project_dir).resolve()
    if not root.is_dir():
        return []
    found: list[Artifact] = []
    seen: set[Path] = set()
    entries = 0

    def add(path: Path, kind: str) -> None:
        resolved = path.resolve()
        if resolved in seen or not _inside(resolved, root):
            return
        if any(_inside(resolved, other) for other in seen):
            return
        seen.add(resolved)
        found.append(Artifact(path=resolved, kind=kind))

    for dirpath, dirs, files in os.walk(root, followlinks=False):
        current = Path(dirpath)
        depth = len(current.relative_to(root).parts)
        entries += len(dirs) + len(files)
        if entries > MAX_ENTRIES or len(found) >= limit:
            break
        keep: list[str] = []
        for name in sorted(dirs):
            sub = current / name
            if name in _SKIP or (name.startswith(".") and name not in _WEB_BUILDS):
                continue
            if sub.is_symlink():
                continue
            kind = _classify_dir(sub, current)
            if kind:
                add(sub, kind)
                continue
            if name == "release" and current.name == "target":
                for executable in _rust_executables(sub):
                    add(executable, "rust")
                continue
            if depth + 1 < MAX_DEPTH:
                keep.append(name)
        dirs[:] = keep
        for name in sorted(files):
            path = current / name
            if path.is_symlink():
                continue
            kind = _classify_file(path, current)
            if kind:
                add(path, kind)
    return found[:limit]
