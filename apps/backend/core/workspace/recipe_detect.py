"""What a project's stack implies a new worktree needs, from its files.

`detect_recipe` (in `recipe.py`) asks this module for its commands. It looks
at the root and at the folders below it, three levels deep, so a monorepo
whose front end lives in `apps/web` and whose API lives in `src/Api` gets one
command for each. Every command still runs from the worktree root: a project
in a sub-folder is named by its tool's own option (`npm --prefix`,
`dotnet restore <solution>`, `cargo fetch --manifest-path`…), so the commands
stay plain argument lists and the detected recipe can be saved as a
`worktree.toml` unchanged.

A folder below a project of the same stack belongs to it (a pnpm workspace
package, a Cargo workspace member, a Maven module) and gets no command of
its own, unless it carries its own lockfile.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from foundation.platform import is_windows

__all__ = ["MAX_DEPTH", "Folder", "detected_steps", "scan"]

#: Levels below the root: `apps/web` is 2, `src/services/api` is 3.
MAX_DEPTH = 3
#: Folders read at most, so a huge checkout does not stall the settings screen.
MAX_FOLDERS = 4000

#: Folders that hold installed, generated or foreign code, never a project.
_SKIPPED = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".workpilot",
        ".venv",
        "venv",
        "node_modules",
        "bower_components",
        "vendor",
        "bin",
        "obj",
        "target",
        "build",
        "dist",
        "out",
        ".gradle",
        ".idea",
        ".vs",
        ".vscode",
        "__pycache__",
        ".tox",
        ".nox",
        ".dart_tool",
        "Pods",
        "_build",
        "deps",
        ".build",
        ".next",
        ".nuxt",
        "coverage",
    }
)
#: `requirements.txt` there is for the documentation build, not the project.
_DOC_FOLDERS = frozenset({"doc", "docs"})

_JS_LOCKS = (
    ("pnpm-lock.yaml", ("pnpm", "install", "--frozen-lockfile")),
    ("yarn.lock", ("yarn", "install")),
    ("bun.lockb", ("bun", "install")),
    ("bun.lock", ("bun", "install")),
    ("package-lock.json", ("npm", "ci")),
)
_SOLUTIONS = (".sln", ".slnx")
_DOTNET_PROJECTS = (".csproj", ".fsproj", ".vbproj")


@dataclass(frozen=True)
class Folder:
    """One folder of the checkout: where it is and the file names it holds."""

    rel: PurePosixPath
    files: frozenset[str]
    dirs: frozenset[str] = field(default_factory=frozenset)
    #: Where it is on disk, to read a file the decision depends on.
    where: Path = field(default_factory=Path)

    @property
    def is_root(self) -> bool:
        return not self.rel.parts

    def has(self, *names: str) -> bool:
        return any(n in self.files for n in names)

    def ending(self, *suffixes: str) -> list[str]:
        return sorted(f for f in self.files if f.lower().endswith(suffixes))

    def path(self, name: str) -> str:
        """`name` in this folder, relative to the root, `/`-separated."""
        return str(self.rel / name) if not self.is_root else name


def scan(root: Path) -> list[Folder]:
    """The root and its folders down to `MAX_DEPTH`, shallowest first."""
    found: list[Folder] = []
    queue: list[tuple[Path, PurePosixPath]] = [(root, PurePosixPath())]
    while queue and len(found) < MAX_FOLDERS:
        here, rel = queue.pop(0)
        try:
            entries = sorted(os.scandir(here), key=lambda e: e.name)
        except OSError:
            continue
        files: set[str] = set()
        dirs: set[str] = set()
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_file():
                    files.add(entry.name)
                elif entry.is_dir():
                    dirs.add(entry.name)
            except OSError:
                continue
        found.append(Folder(rel, frozenset(files), frozenset(dirs), here))
        if len(rel.parts) < MAX_DEPTH:
            queue.extend(
                (here / d, rel / d)
                for d in sorted(dirs)
                if d not in _SKIPPED and not d.startswith(".")
            )
    return found


def _owners(
    folders: Iterable[Folder], is_project: Callable[[Folder], bool]
) -> list[Folder]:
    """Folders that are a project of a stack and lie under no other one."""
    kept: list[Folder] = []
    for folder in folders:
        if not is_project(folder):
            continue
        if any(_under(folder, k) for k in kept):
            continue
        kept.append(folder)
    return kept


def _under(folder: Folder, ancestor: Folder) -> bool:
    return folder.rel.parts[: len(ancestor.rel.parts)] == ancestor.rel.parts


def _venv_python(folder: Folder) -> str:
    if folder.is_root:
        return ".venv\\Scripts\\python.exe" if is_windows() else ".venv/bin/python"
    if is_windows():
        return "\\".join([*folder.rel.parts, ".venv", "Scripts", "python.exe"])
    return folder.path(".venv/bin/python")


# ── one function per stack: the commands for one folder ─────────────────────


def _javascript(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
    steps: list[tuple[str, ...]] = []
    manifests: list[Folder] = []
    for folder in folders:
        lock = next((cmd for name, cmd in _JS_LOCKS if folder.has(name)), None)
        if folder.has("deno.json", "deno.jsonc", "deno.lock"):
            # Deno 2 installs what deno.json and package.json name.
            if folder.is_root:
                steps.append(("deno", "install"))
            else:
                notes.append(
                    f"Deno project in {folder.rel}: deno install runs in its folder only; "
                    "add a script to worktree.toml"
                )
            manifests.append(folder)
            continue
        # A package under a manifest is a workspace member, unless it has its own lock.
        member = any(_under(folder, m) for m in manifests)
        if lock is None and (not folder.has("package.json") or member):
            continue
        manifests.append(folder)
        command = lock or ("npm", "install")
        steps.append(command if folder.is_root else _js_in(command, folder))
    return steps


def _js_in(command: tuple[str, ...], folder: Folder) -> tuple[str, ...]:
    where = str(folder.rel)
    tool, *rest = command
    if tool == "pnpm":
        return ("pnpm", "--dir", where, *rest)
    if tool == "yarn":
        return ("yarn", "--cwd", where, *rest)
    if tool == "bun":
        return ("bun", *rest, "--cwd", where)
    return ("npm", *rest, "--prefix", where)


def _python(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
    def is_project(f: Folder) -> bool:
        docs = bool(f.rel.parts) and f.rel.parts[-1].lower() in _DOC_FOLDERS
        return f.has("uv.lock", "poetry.lock") or (
            f.has("requirements.txt") and not docs
        )

    steps: list[tuple[str, ...]] = []
    for folder in _owners(folders, is_project):
        where = str(folder.rel)
        if folder.has("uv.lock"):
            steps.append(
                ("uv", "sync")
                if folder.is_root
                else ("uv", "--directory", where, "sync")
            )
        elif folder.has("poetry.lock"):
            steps.append(
                ("poetry", "install")
                if folder.is_root
                else ("poetry", "-C", where, "install")
            )
        else:
            steps.append(("python", "-m", "venv", folder.path(".venv")))
            steps.append(
                (
                    _venv_python(folder),
                    "-m",
                    "pip",
                    "install",
                    "-r",
                    folder.path("requirements.txt"),
                )
            )
    return steps


def _dotnet(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
    """A solution when there is one (the `.slnx` over a `.sln` of the same name), else the projects."""

    def solutions(f: Folder) -> list[str]:
        names = f.ending(*_SOLUTIONS)
        newer = {n[: -len(".slnx")] for n in names if n.lower().endswith(".slnx")}
        return [
            n for n in names if not (n.lower().endswith(".sln") and n[:-4] in newer)
        ]

    def projects(f: Folder) -> list[str]:
        return f.ending(*_DOTNET_PROJECTS)

    owners = _owners(folders, lambda f: bool(solutions(f)))
    pick = solutions
    if not owners:
        owners = _owners(folders, lambda f: bool(projects(f)))
        pick = projects
    steps: list[tuple[str, ...]] = []
    for folder in owners:
        names = pick(folder)
        if folder.is_root and len(names) == 1:
            steps.append(("dotnet", "restore"))
            continue
        steps.extend(("dotnet", "restore", folder.path(n)) for n in names)
    roots = folders[:1] + [f for f in owners if not f.is_root]
    if steps:
        for folder in roots:
            if ".config" in folder.dirs and _has_tool_manifest(folder):
                if folder.is_root:
                    steps.append(("dotnet", "tool", "restore"))
                else:
                    manifest = folder.path(".config/dotnet-tools.json")
                    steps.append(
                        ("dotnet", "tool", "restore", "--tool-manifest", manifest)
                    )
    return steps


def _has_tool_manifest(folder: Folder) -> bool:
    return (folder.where / ".config" / "dotnet-tools.json").is_file()


def _simple(
    marker: tuple[str, ...],
    at_root: tuple[str, ...],
    in_folder: Callable[[str], tuple[str, ...]] | None,
    label: str,
) -> Callable[[list[Folder], list[str]], list[tuple[str, ...]]]:
    """A stack that one marker file names and one command prepares."""

    def stack(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
        steps: list[tuple[str, ...]] = []
        for folder in _owners(folders, lambda f: f.has(*marker)):
            if folder.is_root:
                steps.append(at_root)
            elif in_folder is not None:
                steps.append(in_folder(str(folder.rel)))
            else:
                notes.append(
                    f"{label} project in {folder.rel}: its tool has no option to run there; "
                    "add a script to worktree.toml"
                )
        return steps

    return stack


def _go(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
    """Each module downloads its own; a `go.work` covers the modules below it."""
    steps: list[tuple[str, ...]] = []
    workspaces: list[Folder] = []
    for folder in folders:
        if any(_under(folder, w) for w in workspaces):
            continue
        if folder.has("go.work"):
            workspaces.append(folder)
        elif not folder.has("go.mod"):
            continue
        where = str(folder.rel)
        steps.append(
            ("go", "mod", "download")
            if folder.is_root
            else ("go", "mod", "download", "-C", where)
        )
    return steps


def _dart(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
    steps: list[tuple[str, ...]] = []
    for folder in _owners(folders, lambda f: f.has("pubspec.yaml")):
        try:
            text = (folder.where / "pubspec.yaml").read_text(
                encoding="utf-8", errors="replace"
            )
        except OSError:
            text = ""
        tool = "flutter" if "flutter" in text else "dart"
        if folder.is_root:
            steps.append((tool, "pub", "get"))
        else:
            steps.append((tool, "pub", "get", f"--directory={folder.rel}"))
    return steps


def _jvm(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
    """Gradle (its wrapper when the folder has one), else Maven, else sbt."""
    gradle_files = (
        "settings.gradle",
        "settings.gradle.kts",
        "build.gradle",
        "build.gradle.kts",
    )
    steps: list[tuple[str, ...]] = []
    owners = _owners(
        folders,
        lambda f: f.has(
            "gradlew", "gradlew.bat", "pom.xml", "build.sbt", *gradle_files
        ),
    )
    for folder in owners:
        where = str(folder.rel)
        if folder.has("gradlew", "gradlew.bat"):
            if folder.is_root:
                wrapper = "gradlew.bat" if is_windows() else "./gradlew"
                steps.append((wrapper, "dependencies", "--quiet"))
            else:
                wrapper = folder.path("gradlew.bat" if is_windows() else "gradlew")
                steps.append((wrapper, "-p", where, "dependencies", "--quiet"))
        elif folder.has(*gradle_files):
            steps.append(
                ("gradle", "dependencies", "--quiet")
                if folder.is_root
                else ("gradle", "-p", where, "dependencies", "--quiet")
            )
        elif folder.has("pom.xml"):
            steps.append(
                ("mvn", "-q", "dependency:go-offline")
                if folder.is_root
                else (
                    "mvn",
                    "-q",
                    "-f",
                    folder.path("pom.xml"),
                    "dependency:go-offline",
                )
            )
        elif folder.is_root:
            steps.append(("sbt", "update"))
        else:
            notes.append(
                f"sbt project in {folder.rel}: sbt has no option to run there; "
                "add a script to worktree.toml"
            )
    return steps


def _cpp(folders: list[Folder], notes: list[str]) -> list[tuple[str, ...]]:
    """vcpkg manifests and Conan recipes."""
    steps: list[tuple[str, ...]] = []
    for folder in _owners(folders, lambda f: f.has("vcpkg.json")):
        steps.append(
            ("vcpkg", "install")
            if folder.is_root
            else ("vcpkg", "install", f"--x-manifest-root={folder.rel}")
        )
    conan = _owners(folders, lambda f: f.has("conanfile.py", "conanfile.txt"))
    if conan:
        # A machine without a Conan profile refuses every install.
        steps.append(("conan", "profile", "detect", "--exist-ok"))
    for folder in conan:
        where = "." if folder.is_root else str(folder.rel)
        steps.append(("conan", "install", where, "--build=missing"))
    return steps


_STACKS: tuple[Callable[[list[Folder], list[str]], list[tuple[str, ...]]], ...] = (
    _javascript,
    _python,
    _dotnet,
    _go,
    _simple(
        ("Cargo.toml",),
        ("cargo", "fetch"),
        lambda d: ("cargo", "fetch", "--manifest-path", f"{d}/Cargo.toml"),
        "Rust",
    ),
    _simple(
        ("composer.json",),
        ("composer", "install", "--no-interaction"),
        lambda d: ("composer", "install", "--no-interaction", f"--working-dir={d}"),
        "PHP",
    ),
    _simple(
        ("Gemfile",),
        ("bundle", "install"),
        lambda d: ("bundle", "install", f"--gemfile={d}/Gemfile"),
        "Ruby",
    ),
    _dart,
    _jvm,
    _simple(("mix.exs",), ("mix", "deps.get"), None, "Elixir"),
    _simple(
        ("Package.swift",),
        ("swift", "package", "resolve"),
        lambda d: ("swift", "package", "--package-path", d, "resolve"),
        "Swift",
    ),
    _cpp,
)


def detected_steps(
    root: Path, limit: int
) -> tuple[tuple[tuple[str, ...], ...], tuple[str, ...]]:
    """The commands the checkout's stacks imply, at most `limit`, and notes."""
    folders = scan(root)
    notes: list[str] = []
    steps: list[tuple[str, ...]] = []
    for stack in _STACKS:
        for step in stack(folders, notes):
            if step not in steps:
                steps.append(step)
    if len(steps) > limit:
        notes.append(
            f"{len(steps)} commands detected, the first {limit} kept; "
            "list the rest in worktree.toml"
        )
        steps = steps[:limit]
    if not steps:
        notes.append("no package manager recognised in the project")
    return tuple(steps), tuple(notes)
