"""The facts of a pull request, measured without a model.

Every stack, every forge: the type comes from a conventional title (or the
Kanban card's kind), the bump from the title Dependabot and Renovate write,
the files from git, the layers from ``architecture.clean_layers`` when the
project has a Clean Architecture layout, else from the code areas the paths
name. Nothing here reads a file's content: a name is enough to place it.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from pathlib import Path, PurePosixPath

from foundation.change_scope import is_text_only_path
from security.guardrails import glob_to_regex

from .model import CI_STATES, REVIEW_STATES, ChangedFile, PRFacts

#: ``feat(api)!: …``, ``fix: …``, ``chore(deps): …``, ``build(deps-dev): …``.
_CONVENTIONAL = re.compile(
    r"^\s*(?P<type>[a-z]+)(?:\((?P<scope>[^)]{0,64})\))?(?P<bang>!)?:\s", re.I
)
_KNOWN_TYPES = frozenset(
    {
        "feat",
        "fix",
        "perf",
        "refactor",
        "revert",
        "test",
        "docs",
        "style",
        "chore",
        "build",
        "ci",
    }
)
_DEPS_SCOPES = frozenset({"deps", "deps-dev", "dependencies", "dev-deps"})
#: Dependabot: "bump foo from 1.2.3 to 1.3.0"; Renovate: "update dependency foo to v2".
_BUMP_FROM_TO = re.compile(
    r"\bfrom\s+v?(?P<old>\d+(?:\.\d+)*)\S*\s+to\s+v?(?P<new>\d+(?:\.\d+)*)", re.I
)
_BUMP_TO_MAJOR = re.compile(r"\bto\s+v(?P<new>\d+)\s*$", re.I)
_BUMP_WORDS = re.compile(r"^\s*(bump|update|upgrade)\b", re.I)

#: The card kinds of ``tasks.classify`` read as conventional types.
_KIND_TYPES = {
    "feature": "feat",
    "bug_fix": "fix",
    "hotfix": "fix",
    "refactoring": "refactor",
    "test": "test",
    "docs": "docs",
    "upgrade": "deps",
}

#: Dependency manifests and lockfiles, every stack. A bump touching only these
#: (and text) is a dependency change.
_DEPENDENCY_NAMES = frozenset(
    {
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        "bun.lock",
        "requirements.txt",
        "requirements.lock",
        "pyproject.toml",
        "poetry.lock",
        "uv.lock",
        "pipfile",
        "pipfile.lock",
        "directory.packages.props",
        "packages.config",
        "packages.lock.json",
        "global.json",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "gradle.lockfile",
        "libs.versions.toml",
        "go.mod",
        "go.sum",
        "cargo.toml",
        "cargo.lock",
        "composer.json",
        "composer.lock",
        "gemfile",
        "gemfile.lock",
        "pubspec.yaml",
        "pubspec.lock",
        "package.swift",
        "package.resolved",
        "podfile",
        "podfile.lock",
        "mix.exs",
        "mix.lock",
        "deno.json",
        "deno.lock",
    }
)
_DEPENDENCY_SUFFIXES = (".csproj", ".fsproj", ".vbproj")
_DEPENDENCY_PREFIXES = ("requirements", "constraints")
#: CI files a dependency bot updates (action versions). They stay LOCKED for
#: anything else: a bump of an action pin is still a change to the pipeline.
_CI_GLOBS = (
    ".github/workflows/**",
    ".github/actions/**",
    ".gitlab-ci.yml",
    "**/.gitlab-ci.yml",
    "azure-pipelines.yml",
    "**/azure-pipelines*.yml",
    "bitbucket-pipelines.yml",
    "Jenkinsfile",
    "**/Jenkinsfile",
    ".circleci/**",
)

#: Containers of code areas: an area is one level below them.
_AREA_CONTAINERS = frozenset({"apps", "packages", "services", "src", "libs", "modules"})
_NON_CODE_TOP = frozenset({"docs", "doc", "changelog.d", ".github", ".gitlab"})
#: Test folders: they go with the code they test, never an area of their own.
_TEST_TOP = frozenset({"tests", "test", "__tests__", "spec", "specs", "e2e"})


def is_dependency_file(path: str) -> bool:
    name = PurePosixPath(path.replace("\\", "/")).name.lower()
    if name in _DEPENDENCY_NAMES or name.endswith(_DEPENDENCY_SUFFIXES):
        return True
    return name.startswith(_DEPENDENCY_PREFIXES) and name.endswith((".txt", ".in"))


def matches_any(path: str, globs: Iterable[str]) -> bool:
    return any(glob_to_regex(g).match(path) for g in globs)


def is_ci_file(path: str) -> bool:
    return matches_any(path, _CI_GLOBS)


def title_type(title: str, kind: str | None = None) -> tuple[str, bool]:
    """The conventional type of ``title`` and whether it is breaking.

    ``chore(deps)`` / ``build(deps)`` and a bot's "Bump x from 1 to 2" are
    ``deps``. Without a conventional prefix, the card's kind decides; without
    either, ``other``.
    """
    match = _CONVENTIONAL.match(title or "")
    breaking = bool(re.search(r"BREAKING[ -]CHANGE", title or ""))
    if match:
        kind_text = match.group("type").lower()
        scope = (match.group("scope") or "").strip().lower()
        breaking = breaking or bool(match.group("bang"))
        if kind_text in ("chore", "build", "fix") and scope in _DEPS_SCOPES:
            return "deps", breaking
        if kind_text in _KNOWN_TYPES:
            return kind_text, breaking
    if _BUMP_WORDS.match(title or "") and (
        _BUMP_FROM_TO.search(title or "") or "dependenc" in (title or "").lower()
    ):
        return "deps", breaking
    return _KIND_TYPES.get((kind or "").strip().lower(), "other"), breaking


def bump_level(title: str) -> str:
    """``major`` / ``minor`` / ``patch`` from a bot's title, ``unknown`` otherwise.

    Only the first version number is compared for major; a title that names
    no version is ``unknown``, never assumed minor.
    """
    found = _BUMP_FROM_TO.search(title or "")
    if found:
        old = found.group("old").split(".")
        new = found.group("new").split(".")
        if int(old[0]) != int(new[0]):
            return "major"
        if len(old) < 2 or len(new) < 2:
            return "unknown"
        if int(old[1]) != int(new[1]):
            # Semver: below 1.0.0 a minor may break the API, read as a major.
            return "major" if int(old[0]) == 0 else "minor"
        return "patch"
    if _BUMP_TO_MAJOR.search(title or ""):
        return "major"  # Renovate names a major as "to v2"
    return "unknown"


def code_areas(paths: Sequence[str]) -> tuple[str, ...]:
    """The code areas ``paths`` touch: ``apps/backend``, ``src/Shop.Api``, ``lib``…

    Text, documentation, CI files and dependency manifests are no area: a
    manifest moves with the code that needs it. A file at the root is the
    area ``.``.
    """
    areas: set[str] = set()
    for path in paths:
        parts = PurePosixPath(path.replace("\\", "/")).parts
        if (
            not parts
            or is_text_only_path(path)
            or is_ci_file(path)
            or is_dependency_file(path)
        ):
            continue
        if parts[0].lower() in _NON_CODE_TOP or parts[0].lower() in _TEST_TOP:
            continue
        if len(parts) == 1:
            areas.add(".")
        elif parts[0].lower() in _AREA_CONTAINERS and len(parts) > 2:
            areas.add(f"{parts[0]}/{parts[1]}")
        else:
            areas.add(parts[0])
    return tuple(sorted(areas))


def clean_layers_touched(
    project_dir: Path, paths: Sequence[str]
) -> dict[str, str] | None:
    """The Clean Architecture layer of each of ``paths`` that sits in one.

    ``None`` when the project has no layered layout. A path outside every
    layer is left out: ``build_facts`` counts it by its code area instead.
    """
    from architecture.clean_layers import infer_clean_layers

    layers = infer_clean_layers(project_dir)
    if not layers:
        return None
    placed: dict[str, str] = {}
    for path in paths:
        for layer in layers:
            if matches_any(path, layer.patterns):
                placed[path] = layer.name
                break
    return placed


def build_facts(
    files: Sequence[ChangedFile],
    *,
    title: str = "",
    kind: str | None = None,
    base: str = "",
    labels: Sequence[str] = (),
    ci: str = "unknown",
    review: str = "none",
    trust: int | None = None,
    layers: dict[str, str] | None = None,
) -> PRFacts:
    """``PRFacts`` from what the caller measured.

    ``layers`` maps a path to its Clean Architecture layer
    (``clean_layers_touched``); a code path outside every layer counts by its
    code area, so a change across a layered module and another folder still
    reads as two.
    """
    pr_type, breaking = title_type(title, kind)
    paths = [f.path for f in files]
    if (
        pr_type != "deps"
        and paths
        and all(is_dependency_file(p) or is_text_only_path(p) for p in paths)
        and any(is_dependency_file(p) for p in paths)
        and _BUMP_WORDS.match(title or "")
    ):
        pr_type = "deps"
    if pr_type not in ("deps",) and paths and all(is_text_only_path(p) for p in paths):
        pr_type = "docs" if pr_type in ("other", "docs", "chore") else pr_type
    placed = layers or {}
    touched = sorted({name for path, name in placed.items() if path in paths})
    areas = code_areas([p for p in paths if p not in placed])
    layer_source = (
        "layers" if touched and not areas else "mixed" if touched else "areas"
    )
    return PRFacts(
        files=tuple(files),
        type=pr_type,
        breaking=breaking,
        bump=bump_level(title) if pr_type == "deps" else None,
        layers=tuple(touched) + areas,
        layer_source=layer_source,
        base=base,
        labels=tuple(str(label)[:100] for label in labels[:50]),
        ci=ci if ci in CI_STATES else "unknown",
        review=review if review in REVIEW_STATES else "none",
        trust=trust if isinstance(trust, int) and 0 <= trust <= 100 else None,
    )


def changed_files(
    project_dir: Path, base_ref: str, head_ref: str = "HEAD"
) -> list[ChangedFile] | None:
    """The committed change set from the merge base of ``base_ref`` to ``head_ref``.

    ``None`` when git cannot say: an unknown change set is never judged.
    """
    from foundation.git_executable import run_git

    for ref in (base_ref, head_ref):
        if (
            not re.match(r"^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,200}$", ref or "")
            or ".." in ref
        ):
            return None
    merge_base = run_git(
        ["merge-base", base_ref, head_ref], cwd=project_dir, timeout=30
    )
    if merge_base.returncode != 0 or not merge_base.stdout.strip():
        return None
    diff = run_git(
        ["diff", "--numstat", "-M", merge_base.stdout.strip(), head_ref],
        cwd=project_dir,
        timeout=60,
    )
    if diff.returncode != 0:
        return None
    files: list[ChangedFile] = []
    for row in diff.stdout.splitlines():
        parts = row.split("\t")
        if len(parts) < 3:
            continue
        added, deleted = parts[0], parts[1]
        # A rename prints "old\tnew" with -z off as "a => b"; both names count.
        names = parts[2:]
        if len(names) == 1 and " => " in names[0]:
            names = [n.strip("{} ") for n in names[0].split(" => ")]
        binary = added == "-" or deleted == "-"
        for index, name in enumerate(names):
            files.append(
                ChangedFile(
                    path=name.replace("\\", "/"),
                    added=0 if binary or index else int(added),
                    deleted=0 if binary or index else int(deleted),
                    binary=binary,
                )
            )
    return files


__all__ = [
    "build_facts",
    "bump_level",
    "changed_files",
    "clean_layers_touched",
    "code_areas",
    "is_ci_file",
    "is_dependency_file",
    "matches_any",
    "title_type",
]
