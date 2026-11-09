"""Which project file a verification command needs before it can run.

A plan that verifies with ``dotnet test`` in a repo without any project file,
or with ``npm run e2e`` when ``package.json`` has no ``e2e`` script, fails at
the very end of a build, after every token has been spent. Both are visible
from the tree alone. The table covers every stack the board supports; a
command whose tool is not listed is not judged.
"""

from __future__ import annotations

import fnmatch
import json
import shlex
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import PurePosixPath

from .snapshot import Snapshot

# tool -> manifest file-name patterns, any of which makes the tool runnable.
_MANIFESTS: dict[str, tuple[str, ...]] = {
    "npm": ("package.json",),
    "pnpm": ("package.json",),
    "yarn": ("package.json",),
    "bun": ("package.json",),
    "dotnet": ("*.csproj", "*.fsproj", "*.vbproj", "*.sln", "*.slnx"),
    "cargo": ("Cargo.toml",),
    "go": ("go.mod",),
    "mvn": ("pom.xml",),
    "mvnw": ("pom.xml",),
    "gradle": (
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
    ),
    "gradlew": (
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
    ),
    "flutter": ("pubspec.yaml",),
    "dart": ("pubspec.yaml",),
    "composer": ("composer.json",),
    "phpunit": ("phpunit.xml", "phpunit.xml.dist", "composer.json"),
    "pest": ("composer.json",),
    "swift": ("Package.swift",),
    "bundle": ("Gemfile",),
    "rspec": ("Gemfile", ".rspec"),
    "rake": ("Rakefile", "Gemfile"),
    "mix": ("mix.exs",),
    "poetry": ("pyproject.toml",),
    "tox": ("tox.ini", "pyproject.toml"),
    "make": ("Makefile", "makefile", "GNUmakefile"),
    "cmake": ("CMakeLists.txt",),
}

# Directories whose content never belongs to the project being built.
_IGNORED_PARTS = {"node_modules", "vendor", ".git", "bin", "obj", "target", "dist"}

# Sub-commands of a JS package manager that are not script names.
_JS_BUILTINS = {
    "install",
    "i",
    "ci",
    "add",
    "remove",
    "exec",
    "dlx",
    "x",
    "create",
    "init",
    "update",
    "upgrade",
    "outdated",
    "audit",
    "list",
    "ls",
    "why",
    "link",
    "publish",
    "pack",
    "config",
    "set",
    "help",
    "version",
    "info",
    "view",
    "dedupe",
    "prune",
    "rebuild",
    "store",
    "env",
    "cache",
    "login",
    "logout",
    "whoami",
    "workspace",
    "workspaces",
}


@dataclass(frozen=True)
class CommandFinding:
    code: str
    params: dict[str, str]


def _tool_name(token: str) -> str:
    name = PurePosixPath(token.replace("\\", "/")).name
    for suffix in (".exe", ".cmd", ".bat", ".sh"):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
    return name


def _split(command: str) -> list[list[str]]:
    """The simple commands of a command line, split on ``&&``, ``||`` and ``;``."""
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return []
    groups: list[list[str]] = [[]]
    for token in tokens:
        if token in ("&&", "||", ";", "|"):
            groups.append([])
        else:
            groups[-1].append(token)
    return [group for group in groups if group]


def _strip_env(words: list[str]) -> list[str]:
    index = 0
    while (
        index < len(words) and "=" in words[index] and not words[index].startswith("-")
    ):
        index += 1
    return words[index:]


def _manifests_under(
    snapshot: Snapshot, directory: str, patterns: tuple[str, ...]
) -> list[str]:
    prefix = "" if directory in ("", ".") else directory.rstrip("/") + "/"
    found: list[str] = []
    for path in snapshot.files:
        if prefix and not path.startswith(prefix):
            continue
        pure = PurePosixPath(path)
        if _IGNORED_PARTS.intersection(pure.parts[:-1]):
            continue
        if any(fnmatch.fnmatchcase(pure.name, pattern) for pattern in patterns):
            found.append(path)
    return sorted(found, key=lambda p: (p.count("/"), p))


def _script_of(tool: str, args: list[str]) -> str | None:
    """The package.json script a JS command runs, or ``None``."""
    if not args:
        return None
    first = args[0]
    if first in ("run", "run-script"):
        return args[1] if len(args) > 1 and not args[1].startswith("-") else None
    if first.startswith("-"):
        return None
    if tool == "npm":
        # npm only runs these few without ``run``.
        return first if first in ("test", "t", "start", "stop", "restart") else None
    if first in _JS_BUILTINS or (tool == "bun" and first in ("test", "build", "x")):
        return None  # bun test / bun build are bun's own runner and bundler
    return first


def check_command(
    command: str,
    snapshot: Snapshot,
    read_tracked: Callable[[str], str | None],
) -> list[CommandFinding]:
    """What the tree is missing for ``command`` to run, empty when nothing is."""
    findings: list[CommandFinding] = []
    directory = ""
    for words in _split(command):
        words = _strip_env(words)
        if not words:
            continue
        tool = _tool_name(words[0])
        if tool == "cd" and len(words) > 1:
            target = words[1].replace("\\", "/").strip("/")
            directory = (
                "" if target in ("", ".") else str(PurePosixPath(directory) / target)
            )
            if directory and not snapshot.is_directory(directory):
                findings.append(
                    CommandFinding("command_dir_missing", {"dir": directory})
                )
                return findings
            continue
        patterns = _MANIFESTS.get(tool)
        if patterns is None:
            continue
        manifests = _manifests_under(snapshot, directory, patterns)
        if not manifests:
            findings.append(
                CommandFinding(
                    "command_manifest_missing",
                    {
                        "tool": tool,
                        "manifest": " / ".join(patterns[:3]),
                        "command": command,
                    },
                )
            )
            continue
        if tool in ("npm", "pnpm", "yarn", "bun"):
            script = _script_of(tool, words[1:])
            if script == "t":
                script = "test"
            manifest = f"{directory}/package.json" if directory else "package.json"
            if script and manifest in snapshot.files:
                content = read_tracked(manifest)
                if content is None:
                    continue  # created by an earlier subtask: its scripts are unknown
                try:
                    scripts = json.loads(content).get("scripts") or {}
                except (ValueError, AttributeError):
                    continue
                if isinstance(scripts, dict) and script not in scripts:
                    findings.append(
                        CommandFinding(
                            "command_script_missing",
                            {"script": script, "manifest": manifest},
                        )
                    )
    return findings
