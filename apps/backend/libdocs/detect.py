"""Which libraries this task needs documentation for — and which it does not.

The question is not "what does this project depend on" (a manifest answers
that, and downloading all of it would bury the useful page under two hundred
others). It is narrower: *for this task, which library will the agent have to
write code against with no example in the repository to copy?*

That is the case the pipeline currently loses. When a library is already used
in twenty files, the coder reads two of them and writes code that matches the
project — house conventions included, which no upstream page teaches. When it
is used in none, there is nothing to read: the model writes the API it
remembers, and whether that API still exists is a matter of when the library
last changed.

So the signal is **usage evidence in the repository**, not popularity and not a
guess about what the model knows:

* declared in a manifest, imported nowhere → the dependency was added and not
  yet used, or is about to be added by this task. Nothing to copy.
* named by the task, in no manifest at all → a new dependency. Nothing to copy.
* imported in fewer than `THIN_USAGE` files → one example, possibly itself
  written by a previous session against remembered API.
* imported widely → the repository is the better teacher. Skipped, and skipped
  deliberately: spending the download here would replace house conventions with
  a generic quickstart.

Detection is bounded on purpose — a fixed number of manifests, one `git grep`
per candidate, a hard cap on how many libraries survive. This runs before every
build, and a preflight that takes longer than the phase it precedes is a
regression whatever it finds.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_LIMIT",
    "THIN_USAGE",
    "Dependency",
    "LibraryNeed",
    "detect_needs",
    "read_manifests",
    "mentioned_libraries",
    "usage_counts",
]

DEFAULT_LIMIT = 4
"""How many libraries one build downloads at most.

Four is a budget, not a discovery: each page is thousands of tokens the coder
pays for on every turn it reads them, and a task touching more than four
unfamiliar libraries has a planning problem the docs will not fix.
"""

THIN_USAGE = 3
"""Below this many importing files, the repository is not an example set."""

_MAX_MANIFESTS = 24
_MAX_SCAN_DEPTH = 3
_MAX_FALLBACK_FILES = 4000

_IGNORED_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "vendor",
        "dist",
        "build",
        "out",
        "target",
        "coverage",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        ".next",
        ".nuxt",
        ".turbo",
        ".cache",
        ".workpilot",
        ".idea",
        ".vscode",
    }
)

# Manifest file name -> ecosystem. The ecosystem is kept because it decides how
# a name maps to an import statement, which is what the usage count greps for.
_MANIFESTS = {
    "package.json": "npm",
    "pyproject.toml": "pypi",
    "requirements.txt": "pypi",
    "requirements-dev.txt": "pypi",
    "Pipfile": "pypi",
    "go.mod": "go",
    "Cargo.toml": "cargo",
    "composer.json": "composer",
    "Gemfile": "gem",
    "pubspec.yaml": "pub",
    "pom.xml": "maven",
    "build.gradle": "maven",
    "build.gradle.kts": "maven",
}

_SOURCE_SUFFIXES = frozenset(
    {
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".vue",
        ".svelte",
        ".py",
        ".go",
        ".rs",
        ".rb",
        ".php",
        ".java",
        ".kt",
        ".cs",
        ".dart",
        ".scala",
        ".swift",
    }
)

# Words that look like package names in prose and never are. Kept short: the
# real filter is that a candidate must survive the Context7 index, which costs
# one search and is a far better arbiter than a list maintained here.
_STOPWORDS = frozenset(
    {
        "add",
        "api",
        "app",
        "build",
        "cd",
        "ci",
        "class",
        "cli",
        "code",
        "commit",
        "config",
        "css",
        "data",
        "dev",
        "docs",
        "false",
        "file",
        "fix",
        "function",
        "git",
        "html",
        "http",
        "https",
        "id",
        "json",
        "main",
        "make",
        "md",
        "npm",
        "null",
        "pnpm",
        "prod",
        "pytest",
        "python",
        "run",
        "sh",
        "src",
        "test",
        "tests",
        "todo",
        "true",
        "type",
        "ui",
        "url",
        "ux",
        "uv",
        "wip",
        "yaml",
        "yarn",
    }
)

# Distribution name -> module name, for the PyPI packages whose two names
# differ. Not a general solution — there is none short of reading installed
# metadata — but without it `PyYAML` and `PyJWT` look unused in a repository
# that imports them on every other file, and "unused" is what triggers a
# download. Only entries observed in real manifests belong here.
_PYPI_MODULES = {
    "attrs": "attr",
    "beautifulsoup4": "bs4",
    "google-generativeai": "google.generativeai",
    "opencv-python": "cv2",
    "pillow": "PIL",
    "protobuf": "google.protobuf",
    "pyjwt": "jwt",
    "python-dateutil": "dateutil",
    "python-dotenv": "dotenv",
    "pyyaml": "yaml",
    "scikit-learn": "sklearn",
}

_YOUNG_PROJECT_FILES = 50
"""Above this many source files, a task that named no library downloads none.

The fallback below exists for a project too young to have examples of its own
stack. A repository with hundreds of source files has them by definition, and
any library the task actually cared about would have been named in it — so
there the fallback stops guessing rather than spending the budget on whichever
dependency sorts first.
"""

_BACKTICKED = re.compile(r"`([^`\n]{2,40})`")
_SCOPED = re.compile(r"(@[a-z0-9][\w.-]*/[a-z0-9][\w.-]*)", re.IGNORECASE)


@dataclass(frozen=True)
class Dependency:
    """A dependency as a manifest declares it."""

    name: str
    ecosystem: str
    version: str = ""
    manifest: str = ""

    @property
    def short_name(self) -> str:
        """The name as prose and import statements write it.

        `@tanstack/react-query` is discussed as react-query;
        `github.com/gin-gonic/gin` is discussed as gin.
        """
        name = self.name
        if name.startswith("@") and "/" in name:
            return name.split("/", 1)[1]
        if "/" in name:
            return name.rsplit("/", 1)[1]
        return name


@dataclass(frozen=True)
class LibraryNeed:
    """A library this task should have documentation for, and why."""

    name: str
    ecosystem: str = ""
    version: str = ""
    usages: int = 0
    reasons: tuple[str, ...] = field(default_factory=tuple)

    @property
    def rank(self) -> tuple:
        """Sort key, strongest need first."""
        named = "named-by-task" in self.reasons
        undeclared = "not-declared" in self.reasons
        return (named, undeclared, -self.usages)

    def describe(self) -> str:
        why = ", ".join(self.reasons) or "no reason recorded"
        return f"{self.name} ({why})"


# ---------------------------------------------------------------------------
# manifests
# ---------------------------------------------------------------------------


def read_manifests(project_dir: Path) -> dict[str, Dependency]:
    """Every declared dependency of the project, keyed by name.

    A monorepo declares its dependencies per package, so the scan walks a few
    levels rather than reading the root manifest alone — this repository would
    otherwise report zero dependencies, its own being two directories down.
    """
    found: dict[str, Dependency] = {}
    for manifest in _find_manifests(project_dir):
        ecosystem = _MANIFESTS.get(manifest.name, "")
        try:
            for dependency in _parse_manifest(manifest, ecosystem, project_dir):
                found.setdefault(dependency.name, dependency)
        except Exception as exc:  # noqa: BLE001 - a broken manifest is not fatal
            logger.debug("libdocs: could not read %s: %s", manifest, exc)
    return found


def _find_manifests(project_dir: Path) -> list[Path]:
    manifests: list[Path] = []

    def walk(directory: Path, depth: int) -> None:
        if len(manifests) >= _MAX_MANIFESTS or depth > _MAX_SCAN_DEPTH:
            return
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            return
        for entry in entries:
            if entry.is_file() and entry.name in _MANIFESTS:
                manifests.append(entry)
                if len(manifests) >= _MAX_MANIFESTS:
                    return
        for entry in entries:
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            if entry.name in _IGNORED_DIRS:
                continue
            walk(entry, depth + 1)

    walk(project_dir, 0)
    return manifests


def _parse_manifest(path: Path, ecosystem: str, project_dir: Path) -> list[Dependency]:
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        label = str(path.relative_to(project_dir))
    except ValueError:
        label = path.name

    def make(name: str, version: str = "") -> Dependency:
        return Dependency(
            name=name.strip(), ecosystem=ecosystem, version=str(version), manifest=label
        )

    name = path.name
    if name == "package.json":
        payload = json.loads(text or "{}")
        out = []
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            block = payload.get(section)
            if isinstance(block, dict):
                out.extend(make(k, v) for k, v in block.items() if k)
        return out
    if name == "pyproject.toml":
        return [make(n, v) for n, v in _parse_pyproject(text)]
    if name in ("requirements.txt", "requirements-dev.txt", "Pipfile"):
        return [make(n, v) for n, v in _parse_requirements(text)]
    if name == "go.mod":
        return [make(n, v) for n, v in _parse_go_mod(text)]
    if name in ("Cargo.toml", "pubspec.yaml"):
        return [make(n, v) for n, v in _parse_simple_table(text, name)]
    if name == "composer.json":
        payload = json.loads(text or "{}")
        out = []
        for section in ("require", "require-dev"):
            block = payload.get(section)
            if isinstance(block, dict):
                out.extend(make(k, v) for k, v in block.items() if "/" in k)
        return out
    if name == "Gemfile":
        return [
            make(match.group(1))
            for match in re.finditer(r"""^\s*gem\s+['"]([^'"]+)['"]""", text, re.M)
        ]
    if name == "pom.xml":
        return [
            make(match.group(1))
            for match in re.finditer(r"<artifactId>([^<]+)</artifactId>", text)
        ]
    if name.startswith("build.gradle"):
        return [
            make(match.group(2), match.group(3) or "")
            for match in re.finditer(
                r"""['"]([\w.-]+):([\w.-]+)(?::([\w.-]+))?['"]""", text
            )
        ]
    return []


def _parse_pyproject(text: str) -> list[tuple[str, str]]:
    payload = _load_toml(text)
    if not payload:
        # A hand-edited or exotic pyproject still lists its dependencies as
        # requirement strings; reading them with a regex beats reporting none.
        return _parse_requirements(text)
    out: list[tuple[str, str]] = []
    project = payload.get("project")
    if isinstance(project, dict):
        for raw in project.get("dependencies") or []:
            parsed = _split_requirement(str(raw))
            if parsed:
                out.append(parsed)
        optional = project.get("optional-dependencies")
        if isinstance(optional, dict):
            for group in optional.values():
                for raw in group or []:
                    parsed = _split_requirement(str(raw))
                    if parsed:
                        out.append(parsed)
    poetry = ((payload.get("tool") or {}).get("poetry") or {}).get("dependencies")
    if isinstance(poetry, dict):
        for name, spec in poetry.items():
            if name.lower() == "python":
                continue
            version = spec if isinstance(spec, str) else ""
            out.append((name, str(version)))
    return out


def _load_toml(text: str) -> dict:
    try:
        import tomllib
    except ImportError:  # pragma: no cover - Python < 3.11
        try:
            import tomli as tomllib  # type: ignore[no-redef]
        except ImportError:
            return {}
    try:
        return tomllib.loads(text)
    except Exception:  # noqa: BLE001 - malformed TOML falls back to the regex
        return {}


def _parse_requirements(text: str) -> list[tuple[str, str]]:
    out = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        parsed = _split_requirement(line)
        if parsed:
            out.append(parsed)
    return out


_REQUIREMENT = re.compile(r"^([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)")


def _split_requirement(raw: str) -> tuple[str, str] | None:
    match = _REQUIREMENT.match(raw.strip())
    if not match:
        return None
    return match.group(1), match.group(2).strip()


def _parse_go_mod(text: str) -> list[tuple[str, str]]:
    out = []
    for line in text.splitlines():
        line = line.split("//", 1)[0].strip()
        if line.startswith("require "):
            line = line[len("require ") :].strip()
        if not line or line in ("(", ")") or line.startswith(("module", "go ")):
            continue
        parts = line.split()
        if len(parts) >= 2 and "." in parts[0] and "/" in parts[0]:
            out.append((parts[0], parts[1]))
    return out


def _parse_simple_table(text: str, filename: str) -> list[tuple[str, str]]:
    """`[dependencies]` in Cargo.toml, `dependencies:` in pubspec.yaml."""
    if filename == "Cargo.toml":
        payload = _load_toml(text)
        out = []
        for section in ("dependencies", "dev-dependencies"):
            block = payload.get(section)
            if isinstance(block, dict):
                for name, spec in block.items():
                    version = spec if isinstance(spec, str) else ""
                    out.append((name, str(version)))
        return out
    out = []
    in_block = False
    for line in text.splitlines():
        if re.match(r"^(dev_)?dependencies:\s*$", line):
            in_block = True
            continue
        if in_block:
            if line and not line.startswith((" ", "\t")):
                in_block = False
                continue
            match = re.match(r"^\s{2}([A-Za-z0-9_][\w-]*):\s*(.*)$", line)
            if match:
                out.append((match.group(1), match.group(2).strip().strip("^~")))
    return out


# ---------------------------------------------------------------------------
# the task text
# ---------------------------------------------------------------------------


def mentioned_libraries(
    text: str, dependencies: dict[str, Dependency]
) -> tuple[set[str], set[str]]:
    """Libraries the task talks about: (declared, undeclared).

    Declared ones are matched against the manifests, which is exact. Undeclared
    ones can only come out of prose, so they are taken from the two shapes that
    are unambiguous — a backticked token and a scoped npm name — and the
    Context7 search decides whether they are real. A candidate that resolves to
    nothing costs one HTTP call and is dropped.
    """
    lowered = (text or "").lower()
    declared: set[str] = set()
    if lowered:
        for dependency in dependencies.values():
            for candidate in {dependency.name, dependency.short_name}:
                if candidate and _mentions(lowered, candidate):
                    declared.add(dependency.name)
                    break

    undeclared: set[str] = set()
    known = {name.lower() for name in dependencies}
    known |= {dep.short_name.lower() for dep in dependencies.values()}
    for match in _BACKTICKED.finditer(text or ""):
        token = match.group(1).strip()
        if _looks_like_package(token) and token.lower() not in known:
            undeclared.add(token)
    for match in _SCOPED.finditer(text or ""):
        token = match.group(1)
        if token.lower() not in known:
            undeclared.add(token)
    return declared, undeclared


def _mentions(lowered_text: str, name: str) -> bool:
    token = re.escape(name.lower())
    # `-` and `_` are the same word in prose about packages, and a `.` in a
    # package name must stay literal (`next.js` is not `nextxjs`).
    token = token.replace("\\-", "[-_]").replace("_", "[-_]")
    return re.search(rf"(?<![\w.-]){token}(?![\w-])", lowered_text) is not None


def _looks_like_package(token: str) -> bool:
    if " " in token or "\t" in token:
        return False
    if token.startswith("@"):
        return "/" in token
    if "/" in token or "\\" in token or "=" in token or "(" in token:
        return False
    if token.lower() in _STOPWORDS:
        return False
    if Path(token).suffix in _SOURCE_SUFFIXES or token.endswith((".md", ".json")):
        return False
    if not re.match(r"^[A-Za-z][\w.-]{1,39}$", token):
        return False
    return True


# ---------------------------------------------------------------------------
# usage evidence
# ---------------------------------------------------------------------------


def usage_counts(project_dir: Path, names: dict[str, str]) -> dict[str, int]:
    """How many source files reference each name, keyed by name.

    `git grep` when the project is a repository (it respects .gitignore, so
    node_modules and build output cost nothing), a bounded walk otherwise. Both
    ignore manifests: a dependency appears in package.json by definition, and
    counting that would make every declared library look used.
    """
    if not names:
        return {}
    counts = _git_grep_counts(project_dir, names)
    if counts is not None:
        return counts
    return _walk_counts(project_dir, names)


def _patterns_for(name: str, ecosystem: str) -> list[str]:
    """The literals whose presence means "this library is used here"."""
    patterns = {f'"{name}"', f"'{name}'"}
    if ecosystem == "pypi":
        modules = {name.replace("-", "_").lower()}
        mapped = _PYPI_MODULES.get(name.lower())
        if mapped:
            modules.add(mapped)
        for module in modules:
            patterns |= {f"import {module}", f"from {module}"}
    elif ecosystem == "go":
        patterns.add(name)
    elif ecosystem == "maven":
        patterns.add(name)
    else:
        short = name.split("/")[-1]
        patterns |= {f'"{short}"', f"'{short}'"}
    return sorted(patterns)


def _git_grep_counts(project_dir: Path, names: dict[str, str]) -> dict[str, int] | None:
    counts: dict[str, int] = {}
    for name, ecosystem in names.items():
        patterns: list[str] = []
        for pattern in _patterns_for(name, ecosystem):
            patterns.extend(["-e", pattern])
        command = ["git", "grep", "-l", "-I", "-F", *patterns, "--", ".", *_EXCLUDES]
        try:
            result = subprocess.run(
                command,
                cwd=str(project_dir),
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            logger.debug("libdocs: git grep unavailable (%s)", exc)
            return None
        # 1 is "no match"; anything else means git could not answer (not a
        # repository, corrupt index) and the fallback should take over.
        if result.returncode not in (0, 1):
            logger.debug("libdocs: git grep failed: %s", result.stderr.strip()[:200])
            return None
        files = [line for line in result.stdout.splitlines() if _is_source(line)]
        counts[name] = len(files)
    return counts


_EXCLUDES = (
    ":!package.json",
    ":!package-lock.json",
    ":!pnpm-lock.yaml",
    ":!yarn.lock",
    ":!requirements*.txt",
    ":!pyproject.toml",
    ":!Cargo.toml",
    ":!Cargo.lock",
    ":!go.sum",
    ":!composer.json",
    ":!composer.lock",
)


def _is_source(path: str) -> bool:
    return Path(path).suffix in _SOURCE_SUFFIXES


def _walk_counts(project_dir: Path, names: dict[str, str]) -> dict[str, int]:
    compiled = {
        name: [p.lower() for p in _patterns_for(name, eco)]
        for name, eco in names.items()
    }
    counts = dict.fromkeys(names, 0)
    scanned = 0
    for path in _iter_source_files(project_dir):
        scanned += 1
        if scanned > _MAX_FALLBACK_FILES:
            break
        try:
            body = path.read_text(encoding="utf-8", errors="ignore").lower()
        except OSError:
            continue
        for name, patterns in compiled.items():
            if any(pattern in body for pattern in patterns):
                counts[name] += 1
    return counts


def _source_file_count(project_dir: Path, cap: int = 400) -> int:
    """Source files in the repository, counted no further than `cap`.

    Only the comparison against a threshold matters, so the walk stops as soon
    as the answer cannot change.
    """
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode == 0:
            count = 0
            for line in result.stdout.splitlines():
                if _is_source(line):
                    count += 1
                    if count >= cap:
                        break
            return count
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("libdocs: git ls-files unavailable (%s)", exc)

    count = 0
    for _ in _iter_source_files(project_dir):
        count += 1
        if count >= cap:
            break
    return count


def _iter_source_files(project_dir: Path):
    stack = [project_dir]
    while stack:
        directory = stack.pop()
        try:
            entries = list(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir():
                if entry.name in _IGNORED_DIRS or entry.name.startswith("."):
                    continue
                stack.append(entry)
            elif entry.suffix in _SOURCE_SUFFIXES:
                yield entry


# ---------------------------------------------------------------------------
# the decision
# ---------------------------------------------------------------------------


def detect_needs(
    project_dir: Path,
    task_text: str = "",
    *,
    dependencies: dict[str, Dependency] | None = None,
    limit: int = DEFAULT_LIMIT,
) -> list[LibraryNeed]:
    """The libraries this task should have documentation downloaded for."""
    deps = read_manifests(project_dir) if dependencies is None else dependencies
    named, undeclared = mentioned_libraries(task_text, deps)

    # Only candidates get a usage count: the count is one grep each, and asking
    # it of every dependency of a large monorepo is the one part of this that
    # would not stay bounded.
    candidates = {name: deps[name].ecosystem for name in named if name in deps}
    counts = usage_counts(project_dir, candidates) if candidates else {}

    needs: list[LibraryNeed] = []
    for name in sorted(named):
        dependency = deps.get(name)
        if dependency is None:
            continue
        usages = counts.get(name, 0)
        if usages >= THIN_USAGE:
            continue
        reasons = ["named-by-task"]
        reasons.append("unused-in-repo" if usages == 0 else "thin-usage")
        needs.append(
            LibraryNeed(
                name=name,
                ecosystem=dependency.ecosystem,
                version=dependency.version,
                usages=usages,
                reasons=tuple(reasons),
            )
        )
    for name in sorted(undeclared):
        needs.append(
            LibraryNeed(
                name=name,
                reasons=("named-by-task", "not-declared"),
            )
        )

    if not needs:
        needs = _fallback_needs(project_dir, deps)

    needs.sort(key=lambda need: need.rank, reverse=True)
    return needs[: max(0, limit)]


def _fallback_needs(
    project_dir: Path, deps: dict[str, Dependency]
) -> list[LibraryNeed]:
    """What to download when the task text named nothing.

    A task whose description mentions no library still runs against a stack,
    and on a young project that stack has no in-repo examples either — which is
    exactly the situation this package exists for. So the fallback looks at the
    dependencies the project declares and keeps the ones nothing imports yet.
    It is capped hard: this is the weakest signal here, and it must not turn
    every build of a fresh repository into a download queue.
    """
    if not deps:
        return []
    if _source_file_count(project_dir) > _YOUNG_PROJECT_FILES:
        return []
    # Root-most manifests first: in a monorepo those declare the stack the
    # project is actually built on, while a leaf package's dev tooling is the
    # last thing a task needs read to it. Alphabetical order would instead
    # shortlist whatever happens to start with an "@".
    ordered = sorted(
        deps.values(), key=lambda d: (d.manifest.count("/"), d.manifest, d.name)
    )
    shortlist = {d.name: d.ecosystem for d in ordered[:40]}
    counts = usage_counts(project_dir, shortlist)
    unused = [name for name, count in counts.items() if count == 0]
    return [
        LibraryNeed(
            name=name,
            ecosystem=deps[name].ecosystem,
            version=deps[name].version,
            usages=0,
            reasons=("declared", "unused-in-repo"),
        )
        for name in sorted(unused)
    ]
