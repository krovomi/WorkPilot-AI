"""
Onboarding Engine — Generate contextual onboarding material for new team members.

Analyses the codebase and produces architecture overviews, key-file maps,
entry points, runnable commands, naming convention guides and a getting-started
path.

The module is deterministic: it reads files, it never calls an LLM. Everything
downstream (tour, quiz, first tasks, glossary) is derived from what is found
here, so a project that is poorly detected here produces a thin onboarding
package — which is why detection covers stacks by *evidence* (globs, manifest
contents) rather than by a handful of hard-coded root file names.
"""

from __future__ import annotations

import json
import logging
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

logger = logging.getLogger(__name__)


class OnboardingSection(str, Enum):
    ARCHITECTURE = "architecture"
    KEY_FILES = "key_files"
    CONVENTIONS = "conventions"
    DEPENDENCIES = "dependencies"
    GETTING_STARTED = "getting_started"
    TESTING = "testing"
    DEPLOYMENT = "deployment"


@dataclass
class KeyFile:
    """A file highlighted as important for onboarding."""

    path: str
    reason: str
    category: str = ""
    lines: int = 0


@dataclass
class Convention:
    """A detected or documented coding convention."""

    name: str
    description: str
    examples: list[str] = field(default_factory=list)


@dataclass
class ProjectCommand:
    """A command a newcomer can actually run in the checkout."""

    label: str
    command: str
    category: str = "run"  # setup | run | test | lint | build | other
    source: str = ""


@dataclass
class ArchitectureNode:
    """A directory of the project and the role inferred for it."""

    path: str
    role: str
    file_count: int
    languages: list[str] = field(default_factory=list)


@dataclass
class OnboardingGuide:
    """A generated onboarding guide."""

    project_name: str
    sections: dict[str, str] = field(default_factory=dict)
    key_files: list[KeyFile] = field(default_factory=list)
    conventions: list[Convention] = field(default_factory=list)
    tech_stack: list[str] = field(default_factory=list)
    entry_points: list[KeyFile] = field(default_factory=list)
    commands: list[ProjectCommand] = field(default_factory=list)
    architecture: list[ArchitectureNode] = field(default_factory=list)
    stats: dict[str, int] = field(default_factory=dict)
    estimated_reading_time_min: int = 0


# ---------------------------------------------------------------------------
# Walk
# ---------------------------------------------------------------------------

IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "dist",
    "build",
    "out",
    "bin",
    "obj",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    "target",
    ".idea",
    ".vscode",
    ".gradle",
    "vendor",
    "Pods",
    ".terraform",
    ".workpilot",
}

LANGUAGE_BY_EXT = {
    ".py": "Python",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cs": "C#",
    ".fs": "F#",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".kt": "Kotlin",
    ".swift": "Swift",
    ".rb": "Ruby",
    ".php": "PHP",
    ".dart": "Dart",
    ".ex": "Elixir",
    ".exs": "Elixir",
    ".scala": "Scala",
    ".c": "C",
    ".h": "C",
    ".cpp": "C++",
    ".hpp": "C++",
    ".sql": "SQL",
    ".sh": "Shell",
    ".ps1": "PowerShell",
    ".vue": "Vue",
    ".svelte": "Svelte",
}

CODE_EXTENSIONS = frozenset(LANGUAGE_BY_EXT)

_MAX_WALKED_FILES = 6000


@dataclass
class ProjectScan:
    """One bounded walk of the repository, shared by every detector.

    Every detector used to walk the tree itself; on a large checkout that is the
    same directory listing paid for five times, and five slightly different
    ideas of what counts as source.
    """

    root: Path
    files: list[str] = field(default_factory=list)
    dirs: list[str] = field(default_factory=list)
    ext_counts: Counter[str] = field(default_factory=Counter)
    truncated: bool = False

    @property
    def code_files(self) -> list[str]:
        return [f for f in self.files if Path(f).suffix.lower() in CODE_EXTENSIONS]

    def has(self, relative: str) -> bool:
        return (self.root / relative).exists()

    def find(self, pattern: str, *, limit: int = 20) -> list[str]:
        """Match relative paths against a glob-ish pattern (``*.csproj``)."""
        rx = re.compile(
            "^" + re.escape(pattern).replace(r"\*", "[^/]*").replace(r"\?", ".") + "$"
        )
        out = [f for f in self.files if rx.match(Path(f).name)]
        return sorted(out)[:limit]

    def read(self, relative: str, *, max_chars: int = 200_000) -> str:
        try:
            return (self.root / relative).read_text(encoding="utf-8", errors="replace")[
                :max_chars
            ]
        except OSError:
            return ""

    def read_json(self, relative: str) -> dict:
        raw = self.read(relative)
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}


def scan_project(root: Path, *, max_files: int = _MAX_WALKED_FILES) -> ProjectScan:
    """Walk ``root`` once, pruning vendored directories."""
    scan = ProjectScan(root=root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir != ".":
            scan.dirs.append(rel_dir.replace(os.sep, "/"))
        for name in sorted(filenames):
            if len(scan.files) >= max_files:
                scan.truncated = True
                return scan
            rel = name if rel_dir == "." else f"{rel_dir.replace(os.sep, '/')}/{name}"
            scan.files.append(rel)
            scan.ext_counts[Path(name).suffix.lower()] += 1
    return scan


# ---------------------------------------------------------------------------
# Detection tables
# ---------------------------------------------------------------------------

# Root-level marker files → technology.
_FILE_INDICATORS: dict[str, str] = {
    "package.json": "Node.js",
    "tsconfig.json": "TypeScript",
    "pnpm-workspace.yaml": "pnpm workspace",
    "pyproject.toml": "Python",
    "requirements.txt": "Python",
    "setup.py": "Python",
    "Pipfile": "Python",
    "Cargo.toml": "Rust",
    "go.mod": "Go",
    "pom.xml": "Java (Maven)",
    "build.gradle": "Java/Kotlin (Gradle)",
    "build.gradle.kts": "Kotlin (Gradle)",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "pubspec.yaml": "Flutter/Dart",
    "Package.swift": "Swift",
    "mix.exs": "Elixir",
    "CMakeLists.txt": "CMake",
    "Makefile": "Make",
    "docker-compose.yml": "Docker Compose",
    "docker-compose.yaml": "Docker Compose",
    "Dockerfile": "Docker",
    "global.json": ".NET",
    "Directory.Build.props": ".NET",
    "Directory.Packages.props": ".NET (central package management)",
    ".github/workflows": "GitHub Actions",
    ".gitlab-ci.yml": "GitLab CI",
    "azure-pipelines.yml": "Azure Pipelines",
    "Jenkinsfile": "Jenkins",
    "terraform": "Terraform",
    "helm": "Helm",
    "k8s": "Kubernetes",
    "kubernetes": "Kubernetes",
}

# Glob patterns matched anywhere in the tree → technology.
_GLOB_INDICATORS: list[tuple[str, str]] = [
    ("*.sln", ".NET (solution)"),
    ("*.csproj", "C# / .NET"),
    ("*.fsproj", "F# / .NET"),
    ("*.vbproj", "VB.NET"),
    ("*.xcodeproj", "Xcode"),
    ("*.tf", "Terraform"),
    ("Chart.yaml", "Helm"),
    ("*.ipynb", "Jupyter"),
    ("*.proto", "Protocol Buffers"),
]

# npm dependency name (or prefix) → framework label.
_NPM_FRAMEWORKS: list[tuple[str, str]] = [
    ("next", "Next.js"),
    ("nuxt", "Nuxt"),
    ("react", "React"),
    ("vue", "Vue"),
    ("@angular/core", "Angular"),
    ("svelte", "Svelte"),
    ("electron", "Electron"),
    ("express", "Express"),
    ("@nestjs/core", "NestJS"),
    ("fastify", "Fastify"),
    ("vite", "Vite"),
    ("webpack", "webpack"),
    ("tailwindcss", "Tailwind CSS"),
    ("zustand", "Zustand"),
    ("redux", "Redux"),
    ("prisma", "Prisma"),
    ("typeorm", "TypeORM"),
    ("jest", "Jest"),
    ("vitest", "Vitest"),
    ("@playwright/test", "Playwright"),
    ("cypress", "Cypress"),
]

_PY_FRAMEWORKS: list[tuple[str, str]] = [
    ("django", "Django"),
    ("fastapi", "FastAPI"),
    ("flask", "Flask"),
    ("sqlalchemy", "SQLAlchemy"),
    ("pydantic", "Pydantic"),
    ("celery", "Celery"),
    ("pytest", "pytest"),
    ("pandas", "pandas"),
    ("numpy", "NumPy"),
    ("torch", "PyTorch"),
    ("langchain", "LangChain"),
    ("claude-agent-sdk", "Claude Agent SDK"),
]

_NUGET_FRAMEWORKS: list[tuple[str, str]] = [
    ("Microsoft.AspNetCore", "ASP.NET Core"),
    ("Microsoft.EntityFrameworkCore", "Entity Framework Core"),
    ("Dapper", "Dapper"),
    ("MediatR", "MediatR"),
    ("FluentValidation", "FluentValidation"),
    ("FluentAssertions", "FluentAssertions"),
    ("AutoMapper", "AutoMapper"),
    ("Serilog", "Serilog"),
    ("xunit", "xUnit"),
    ("NUnit", "NUnit"),
    ("MSTest", "MSTest"),
    ("Moq", "Moq"),
    ("NSubstitute", "NSubstitute"),
    ("Swashbuckle", "Swagger / Swashbuckle"),
    ("MassTransit", "MassTransit"),
    ("Polly", "Polly"),
    ("Hangfire", "Hangfire"),
]

# Entry-point candidates: relative path or glob → why it matters.
_ENTRY_POINT_GLOBS: list[tuple[str, str]] = [
    ("Program.cs", "Application entry point and host configuration"),
    ("Startup.cs", "Service registration and HTTP pipeline configuration"),
    ("main.py", "Python entry point"),
    ("app.py", "Application entry point"),
    ("manage.py", "Django management entry point"),
    ("run.py", "Runtime entry point"),
    ("__main__.py", "Module executed with `python -m`"),
    ("main.go", "Go entry point"),
    ("main.rs", "Rust entry point"),
    ("Main.java", "Java entry point"),
    ("main.dart", "Flutter entry point"),
    ("index.ts", "Module entry point"),
    ("index.js", "Module entry point"),
    ("main.ts", "Application bootstrap"),
    ("main.tsx", "UI bootstrap"),
    ("App.tsx", "Root React component"),
    ("server.ts", "HTTP server bootstrap"),
    ("server.js", "HTTP server bootstrap"),
]

# Directory name → role. Longest, most specific names first.
_DIRECTORY_ROLES: list[tuple[str, str]] = [
    ("controllers", "HTTP entry points (controllers)"),
    ("endpoints", "HTTP endpoints"),
    ("infrastructure", "Infrastructure layer — persistence, external services"),
    ("persistence", "Persistence layer"),
    ("application", "Application layer — use cases and orchestration"),
    ("domain", "Domain layer — entities and business rules"),
    ("usecases", "Use cases"),
    ("handlers", "Request/command handlers"),
    ("repositories", "Data access repositories"),
    ("migrations", "Database schema migrations"),
    ("entities", "Domain entities"),
    ("models", "Data models"),
    ("dtos", "Data transfer objects"),
    ("contracts", "Shared contracts and interfaces"),
    ("interfaces", "Abstractions and interfaces"),
    ("services", "Business services"),
    ("components", "UI components"),
    ("hooks", "Reusable UI hooks"),
    ("stores", "Client-side state stores"),
    ("pages", "Routed pages"),
    ("views", "Views"),
    ("routes", "Route definitions"),
    ("middleware", "Request middleware"),
    ("config", "Configuration"),
    ("configuration", "Configuration"),
    ("scripts", "Automation and build scripts"),
    ("tools", "Developer tooling"),
    ("docs", "Documentation"),
    ("doc", "Documentation"),
    ("tests", "Automated tests"),
    ("test", "Automated tests"),
    ("spec", "Automated tests"),
    ("e2e", "End-to-end tests"),
    ("fixtures", "Test fixtures"),
    ("assets", "Static assets"),
    ("public", "Publicly served static files"),
    ("static", "Static files"),
    ("locales", "Translations"),
    ("i18n", "Translations"),
    ("api", "API surface"),
    ("cli", "Command-line interface"),
    ("core", "Core building blocks"),
    ("shared", "Code shared across modules"),
    ("common", "Code shared across modules"),
    ("utils", "Utilities"),
    ("lib", "Library code"),
    ("src", "Application source"),
    ("app", "Application code"),
    ("apps", "Applications of the monorepo"),
    ("packages", "Packages of the monorepo"),
    ("server", "Server-side code"),
    ("client", "Client-side code"),
    ("frontend", "Frontend application"),
    ("backend", "Backend application"),
    ("mobile", "Mobile application"),
    ("infra", "Infrastructure as code"),
    ("deploy", "Deployment manifests"),
    (".github", "CI/CD workflows and repository automation"),
]

_LINTER_CONFIGS: dict[str, tuple[str, str]] = {
    ".eslintrc.js": ("ESLint", "JavaScript/TypeScript linting"),
    ".eslintrc.json": ("ESLint", "JavaScript/TypeScript linting"),
    "eslint.config.js": ("ESLint", "JavaScript/TypeScript linting"),
    "biome.json": ("Biome", "Formatting and linting"),
    "biome.jsonc": ("Biome", "Formatting and linting"),
    ".prettierrc": ("Prettier", "Code formatting"),
    ".prettierrc.json": ("Prettier", "Code formatting"),
    "ruff.toml": ("Ruff", "Python linting and formatting"),
    ".ruff.toml": ("Ruff", "Python linting and formatting"),
    ".flake8": ("Flake8", "Python linting"),
    "setup.cfg": ("setup.cfg", "Python tooling configuration"),
    "mypy.ini": ("mypy", "Python static typing"),
    ".editorconfig": ("EditorConfig", "Editor-level formatting rules"),
    ".csharpierrc": ("CSharpier", "C# formatting"),
    ".globalconfig": ("Roslyn analyzers", "C# analyzer rules"),
    "stylecop.json": ("StyleCop", "C# style rules"),
    ".golangci.yml": ("golangci-lint", "Go linting"),
    "rustfmt.toml": ("rustfmt", "Rust formatting"),
    "clippy.toml": ("Clippy", "Rust linting"),
    ".rubocop.yml": ("RuboCop", "Ruby linting"),
    ".pre-commit-config.yaml": ("pre-commit", "Hooks run before each commit"),
    "commitlint.config.js": ("commitlint", "Commit message convention"),
    "lefthook.yml": ("Lefthook", "Git hooks"),
}

_DOC_FILES: list[tuple[str, str, str]] = [
    ("README.md", "Project documentation entry point", "docs"),
    ("CONTRIBUTING.md", "Contribution guidelines", "docs"),
    ("ARCHITECTURE.md", "Architecture overview", "docs"),
    ("AGENTS.md", "Instructions for coding agents", "docs"),
    ("CLAUDE.md", "Instructions for Claude Code", "docs"),
    ("CHANGELOG.md", "Release history", "docs"),
    ("SECURITY.md", "Security policy", "docs"),
    ("CODE_OF_CONDUCT.md", "Community rules", "docs"),
    ("LICENSE", "License terms", "docs"),
]

_CONFIG_FILES: list[tuple[str, str, str]] = [
    ("package.json", "Node.js dependencies and scripts", "config"),
    ("pnpm-workspace.yaml", "pnpm workspace layout", "config"),
    ("tsconfig.json", "TypeScript compiler configuration", "config"),
    ("pyproject.toml", "Python project configuration", "config"),
    ("requirements.txt", "Python dependencies", "config"),
    ("Cargo.toml", "Rust crate manifest", "config"),
    ("go.mod", "Go module definition", "config"),
    ("pom.xml", "Maven build definition", "config"),
    ("build.gradle", "Gradle build definition", "config"),
    ("Gemfile", "Ruby dependencies", "config"),
    ("composer.json", "PHP dependencies", "config"),
    ("Directory.Packages.props", "Centrally managed NuGet versions", "config"),
    ("global.json", "Pinned .NET SDK version", "config"),
    ("appsettings.json", "Runtime application settings", "config"),
    (".env.example", "Environment variables template", "config"),
    (".env.sample", "Environment variables template", "config"),
    ("docker-compose.yml", "Service orchestration", "infra"),
    ("docker-compose.yaml", "Service orchestration", "infra"),
    ("Dockerfile", "Container image definition", "infra"),
    ("Makefile", "Task entry points", "infra"),
]


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class OnboardingEngine:
    """Analyse a codebase and generate onboarding material.

    Usage::

        engine = OnboardingEngine()
        guide = engine.generate(Path("/my/repo"))
    """

    def generate(
        self, repo_root: Path, scan: ProjectScan | None = None
    ) -> OnboardingGuide:
        """Generate a full onboarding guide from the repo."""
        root = Path(repo_root).resolve()
        scan = scan or scan_project(root)

        guide = OnboardingGuide(project_name=root.name)
        guide.tech_stack = self._detect_tech_stack(scan)
        guide.architecture = self._map_architecture(scan)
        guide.entry_points = self._detect_entry_points(scan)
        guide.key_files = self._identify_key_files(scan, guide.entry_points)
        guide.conventions = self._detect_conventions(scan)
        guide.commands = self._detect_commands(scan)
        guide.stats = self._collect_stats(scan)

        guide.sections[OnboardingSection.GETTING_STARTED.value] = self._getting_started(
            scan, guide.commands
        )
        guide.sections[OnboardingSection.ARCHITECTURE.value] = self._architecture_text(
            guide.architecture
        )
        guide.sections[OnboardingSection.TESTING.value] = self._testing_text(
            scan, guide.commands
        )
        guide.sections[OnboardingSection.DEPENDENCIES.value] = self._dependencies_text(
            scan
        )
        deployment = self._deployment_text(scan)
        if deployment:
            guide.sections[OnboardingSection.DEPLOYMENT.value] = deployment

        guide.estimated_reading_time_min = max(
            5, len(guide.key_files) * 2 + len(guide.architecture)
        )
        return guide

    # -- tech stack --------------------------------------------------------

    def _detect_tech_stack(self, scan: ProjectScan) -> list[str]:
        stack: list[str] = []

        def add(tech: str) -> None:
            if tech and tech not in stack:
                stack.append(tech)

        for indicator, tech in _FILE_INDICATORS.items():
            if scan.has(indicator):
                add(tech)

        for pattern, tech in _GLOB_INDICATORS:
            if scan.find(pattern, limit=1):
                add(tech)

        # Dominant languages carry more signal than a manifest sitting at the
        # root: a repo can declare Node and be 90% C#.
        for language, count in self._language_counts(scan).most_common(4):
            if count >= 3:
                add(language)

        for framework in self._npm_frameworks(scan):
            add(framework)
        for framework in self._python_frameworks(scan):
            add(framework)
        for framework in self._dotnet_frameworks(scan):
            add(framework)

        return stack

    def _language_counts(self, scan: ProjectScan) -> Counter[str]:
        counts: Counter[str] = Counter()
        for rel in scan.files:
            language = LANGUAGE_BY_EXT.get(Path(rel).suffix.lower())
            if language:
                counts[language] += 1
        return counts

    def _npm_frameworks(self, scan: ProjectScan) -> list[str]:
        manifest = scan.read_json("package.json")
        if not manifest:
            return []
        deps: set[str] = set()
        for key in ("dependencies", "devDependencies", "peerDependencies"):
            section = manifest.get(key)
            if isinstance(section, dict):
                deps.update(section)
        return [label for name, label in _NPM_FRAMEWORKS if name in deps]

    def _python_frameworks(self, scan: ProjectScan) -> list[str]:
        blob = ""
        for name in ("requirements.txt", "pyproject.toml", "Pipfile", "setup.py"):
            if scan.has(name):
                blob += scan.read(name, max_chars=40_000).lower()
        if not blob:
            return []
        return [label for name, label in _PY_FRAMEWORKS if name in blob]

    def _dotnet_frameworks(self, scan: ProjectScan) -> list[str]:
        projects = scan.find("*.csproj", limit=12) + scan.find("*.fsproj", limit=4)
        if not projects:
            projects = scan.find("Directory.Packages.props", limit=1)
        if not projects:
            return []
        blob = "".join(scan.read(p, max_chars=40_000) for p in projects)
        found = [label for name, label in _NUGET_FRAMEWORKS if name in blob]
        target = re.search(r"<TargetFrameworks?>([^<;]+)", blob)
        if target:
            found.insert(0, f".NET ({target.group(1).strip()})")
        return found

    # -- structure ---------------------------------------------------------

    def _map_architecture(
        self, scan: ProjectScan, *, limit: int = 14
    ) -> list[ArchitectureNode]:
        """Describe the directories a newcomer will actually open."""
        counts: Counter[str] = Counter()
        languages: dict[str, Counter[str]] = {}

        for rel in scan.files:
            parts = rel.split("/")
            if len(parts) < 2:
                continue
            if parts[0].startswith(".") and parts[0] != ".github":
                continue
            for depth in (1, 2):
                if len(parts) <= depth:
                    continue
                node = "/".join(parts[:depth])
                counts[node] += 1
                language = LANGUAGE_BY_EXT.get(Path(rel).suffix.lower())
                if language:
                    languages.setdefault(node, Counter())[language] += 1

        # A depth-2 node only earns its line when it is not just its parent.
        selected: list[str] = []
        for node, count in counts.most_common():
            if count < 2:
                continue
            parent = node.rsplit("/", 1)[0] if "/" in node else None
            if parent and counts.get(parent, 0) == count:
                # Parent has nothing else in it — keep the deeper, informative one.
                if parent in selected:
                    selected.remove(parent)
            selected.append(node)
            if len(selected) >= limit:
                break

        nodes: list[ArchitectureNode] = []
        for node in sorted(selected):
            nodes.append(
                ArchitectureNode(
                    path=node,
                    role=self._role_for(node),
                    file_count=counts[node],
                    languages=[
                        lang
                        for lang, _ in languages.get(node, Counter()).most_common(3)
                    ],
                )
            )
        return nodes

    def _role_for(self, path: str) -> str:
        name = path.rsplit("/", 1)[-1].lower()
        for candidate, role in _DIRECTORY_ROLES:
            if name == candidate:
                return role
        # Substring matching, but test markers win: `Shop.Domain.Tests` is a
        # test project, not the domain layer.
        for candidate in ("tests", "test", "spec", "e2e"):
            if candidate in re.split(r"[.\-_]", name):
                return dict(_DIRECTORY_ROLES)[candidate]
        for candidate, role in _DIRECTORY_ROLES:
            if candidate in name:
                return role
        return "Project code"

    @staticmethod
    def _is_hidden(relative: str) -> bool:
        """A path under a dot-directory (``.design-system/…``).

        Those trees are tooling, not the product: an entry point found there
        sends the newcomer to a sandbox instead of the application.
        """
        return any(part.startswith(".") for part in relative.split("/")[:-1])

    def _detect_entry_points(
        self, scan: ProjectScan, *, limit: int = 6
    ) -> list[KeyFile]:
        found: list[KeyFile] = []
        seen: set[str] = set()
        for name, reason in _ENTRY_POINT_GLOBS:
            for rel in scan.find(name, limit=6):
                depth = rel.count("/")
                if depth > 4 or rel in seen or self._is_hidden(rel):
                    continue
                seen.add(rel)
                found.append(
                    KeyFile(
                        path=rel,
                        reason=reason,
                        category="entrypoint",
                        lines=self._line_count(scan, rel),
                    )
                )
        found.sort(key=lambda kf: (kf.path.count("/"), kf.path))
        return found[:limit]

    def _identify_key_files(
        self, scan: ProjectScan, entry_points: list[KeyFile]
    ) -> list[KeyFile]:
        key_files: list[KeyFile] = []
        seen: set[str] = set()

        def push(path: str, reason: str, category: str) -> None:
            if path in seen:
                return
            seen.add(path)
            key_files.append(
                KeyFile(
                    path=path,
                    reason=reason,
                    category=category,
                    lines=self._line_count(scan, path),
                )
            )

        for filename, reason, category in _DOC_FILES:
            if scan.has(filename):
                push(filename, reason, category)

        for filename, reason, category in _CONFIG_FILES:
            if scan.has(filename):
                push(filename, reason, category)

        for solution in scan.find("*.sln", limit=2):
            push(solution, "Solution grouping every .NET project", "config")

        for workflow in [f for f in scan.files if f.startswith(".github/workflows/")][
            :3
        ]:
            push(workflow, "Continuous integration pipeline", "ci")

        for entry in entry_points:
            push(entry.path, entry.reason, "entrypoint")

        for path, reason in self._central_source_files(scan):
            push(path, reason, "source")

        return key_files[:24]

    def _central_source_files(
        self, scan: ProjectScan, *, limit: int = 6
    ) -> list[tuple[str, str]]:
        """The biggest source file of each significant directory.

        Size is a crude proxy for importance, but it is the one signal available
        without parsing every language: the file everyone edits is rarely the
        smallest one in its folder.
        """
        by_dir: dict[str, list[tuple[int, str]]] = {}
        for rel in scan.code_files:
            if any(
                part in {"tests", "test", "__tests__", "spec"}
                for part in rel.split("/")
            ):
                continue
            if self._is_hidden(rel):
                continue
            directory = rel.rsplit("/", 1)[0] if "/" in rel else "."
            lines = self._line_count(scan, rel)
            if lines < 40:
                continue
            by_dir.setdefault(directory, []).append((lines, rel))

        ranked: list[tuple[int, str, str]] = []
        for directory, entries in by_dir.items():
            entries.sort(reverse=True)
            lines, rel = entries[0]
            ranked.append((lines, rel, directory))

        ranked.sort(reverse=True)
        out: list[tuple[str, str]] = []
        for lines, rel, directory in ranked[:limit]:
            out.append(
                (
                    rel,
                    f"Largest source file of `{directory}` ({lines} lines) — "
                    "usually where that area's logic lives",
                )
            )
        return out

    def _line_count(self, scan: ProjectScan, relative: str) -> int:
        try:
            with (scan.root / relative).open(
                "r", encoding="utf-8", errors="replace"
            ) as handle:
                return sum(1 for _ in handle)
        except OSError:
            return 0

    # -- conventions -------------------------------------------------------

    def _detect_conventions(self, scan: ProjectScan) -> list[Convention]:
        conventions: list[Convention] = []
        seen: set[str] = set()

        for filename, (name, description) in _LINTER_CONFIGS.items():
            if scan.has(filename) and name not in seen:
                seen.add(name)
                conventions.append(
                    Convention(
                        name=name,
                        description=f"{description} — configured via `{filename}`",
                        examples=[filename],
                    )
                )

        manifest = scan.read_json("package.json")
        scripts = manifest.get("scripts") if isinstance(manifest, dict) else None
        if isinstance(scripts, dict) and ("lint" in scripts or "format" in scripts):
            conventions.append(
                Convention(
                    name="Formatting is scripted",
                    description="Run the project's own script rather than your editor's defaults.",
                    examples=[
                        f"{k}: {v}"
                        for k, v in scripts.items()
                        if k in {"lint", "format"}
                    ],
                )
            )

        naming = self._detect_file_naming(scan)
        if naming:
            conventions.append(naming)

        tests = self._detect_test_convention(scan)
        if tests:
            conventions.append(tests)

        indentation = self._detect_indentation(scan)
        if indentation:
            conventions.append(indentation)

        if scan.has(".github/PULL_REQUEST_TEMPLATE.md") or scan.has(
            ".github/pull_request_template.md"
        ):
            conventions.append(
                Convention(
                    name="Pull request template",
                    description="Every PR is expected to fill the repository's template.",
                    examples=[".github/pull_request_template.md"],
                )
            )

        return conventions

    def _detect_file_naming(self, scan: ProjectScan) -> Convention | None:
        styles: Counter[str] = Counter()
        examples: dict[str, str] = {}
        for rel in scan.code_files[:800]:
            stem = Path(rel).stem
            if not stem or stem.startswith((".", "_")):
                continue
            if re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", stem):
                style = "kebab-case"
            elif re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)+", stem):
                style = "snake_case"
            elif re.fullmatch(r"[A-Z][A-Za-z0-9]*", stem):
                style = "PascalCase"
            elif re.fullmatch(r"[a-z]+[A-Z][A-Za-z0-9]*", stem):
                style = "camelCase"
            else:
                continue
            styles[style] += 1
            examples.setdefault(style, rel)

        if not styles:
            return None
        style, count = styles.most_common(1)[0]
        total = sum(styles.values())
        # Single-word stems (`main.tsx`, `card.tsx`) match no style and are
        # excluded above: they are compatible with every convention, so
        # counting them would only dilute the vote.
        if total < 5 or count / total < 0.5:
            return None
        return Convention(
            name=f"File names use {style}",
            description=f"{count} of {total} source files follow it — match it for new files.",
            examples=[examples[style]],
        )

    def _detect_test_convention(self, scan: ProjectScan) -> Convention | None:
        patterns = {
            "tests/ directory": [
                f for f in scan.files if f.startswith(("tests/", "test/"))
            ],
            "*.test.ts / *.spec.ts beside the code": [
                f for f in scan.files if re.search(r"\.(test|spec)\.[tj]sx?$", f)
            ],
            "test_*.py": [
                f for f in scan.files if re.match(r"(.*/)?test_[^/]+\.py$", f)
            ],
            "*Tests.cs": [f for f in scan.files if f.endswith("Tests.cs")],
            "*_test.go": [f for f in scan.files if f.endswith("_test.go")],
        }
        best = max(patterns.items(), key=lambda item: len(item[1]))
        if len(best[1]) < 2:
            return None
        return Convention(
            name=f"Tests live as {best[0]}",
            description=f"{len(best[1])} matching file(s) — put new tests where the existing ones are.",
            examples=sorted(best[1])[:3],
        )

    def _detect_indentation(self, scan: ProjectScan) -> Convention | None:
        tabs = spaces = 0
        for rel in scan.code_files[:60]:
            text = scan.read(rel, max_chars=20_000)
            for line in text.splitlines()[:200]:
                if line.startswith("\t"):
                    tabs += 1
                elif line.startswith("    "):
                    spaces += 1
        if tabs + spaces < 30:
            return None
        style = "tabs" if tabs > spaces else "4 spaces"
        return Convention(
            name=f"Indentation: {style}",
            description="Measured on the existing sources; the formatter enforces it.",
        )

    # -- commands ----------------------------------------------------------

    def _detect_commands(self, scan: ProjectScan) -> list[ProjectCommand]:
        commands: list[ProjectCommand] = []
        seen: set[str] = set()

        def push(label: str, command: str, category: str, source: str) -> None:
            if command in seen:
                return
            seen.add(command)
            commands.append(
                ProjectCommand(
                    label=label, command=command, category=category, source=source
                )
            )

        manifest = scan.read_json("package.json")
        runner = self._node_runner(scan)
        scripts = manifest.get("scripts") if isinstance(manifest, dict) else None
        if isinstance(scripts, dict):
            push("Install dependencies", f"{runner} install", "setup", "package.json")
            for name in sorted(scripts):
                category = self._script_category(name)
                push(f"{name}", f"{runner} run {name}", category, "package.json")

        if scan.has("requirements.txt"):
            push(
                "Create the virtual environment",
                "python -m venv .venv",
                "setup",
                "requirements.txt",
            )
            push(
                "Install dependencies",
                "pip install -r requirements.txt",
                "setup",
                "requirements.txt",
            )
        if scan.has("pyproject.toml"):
            raw = scan.read("pyproject.toml", max_chars=40_000)
            if "[tool.poetry]" in raw:
                push(
                    "Install dependencies", "poetry install", "setup", "pyproject.toml"
                )
            elif "[tool.uv]" in raw or scan.has("uv.lock"):
                push("Install dependencies", "uv sync", "setup", "pyproject.toml")
            else:
                push(
                    "Install the project", "pip install -e .", "setup", "pyproject.toml"
                )
            if "pytest" in raw or scan.has("pytest.ini"):
                push("Run the tests", "pytest -v", "test", "pyproject.toml")
        if scan.has("requirements.txt") and any(
            f.startswith(("tests/", "test/")) for f in scan.files
        ):
            push("Run the tests", "pytest -v", "test", "tests/")

        if scan.find("*.sln", limit=1) or scan.find("*.csproj", limit=1):
            push("Restore packages", "dotnet restore", "setup", ".NET project")
            push("Build the solution", "dotnet build", "build", ".NET project")
            push("Run the tests", "dotnet test", "test", ".NET project")
            for project in scan.find("*.csproj", limit=6):
                text = scan.read(project, max_chars=20_000)
                if "Microsoft.NET.Sdk.Web" in text or "AspNetCore" in text:
                    push(
                        f"Run {Path(project).stem}",
                        f"dotnet run --project {project}",
                        "run",
                        project,
                    )
                    break

        if scan.has("Cargo.toml"):
            push("Build", "cargo build", "build", "Cargo.toml")
            push("Run the tests", "cargo test", "test", "Cargo.toml")
        if scan.has("go.mod"):
            push("Build", "go build ./...", "build", "go.mod")
            push("Run the tests", "go test ./...", "test", "go.mod")
        if scan.has("pom.xml"):
            push("Build", "mvn package", "build", "pom.xml")
            push("Run the tests", "mvn test", "test", "pom.xml")
        if scan.has("Gemfile"):
            push("Install dependencies", "bundle install", "setup", "Gemfile")
        if scan.has("docker-compose.yml") or scan.has("docker-compose.yaml"):
            push("Start the services", "docker compose up -d", "run", "docker-compose")

        for target in self._makefile_targets(scan):
            push(
                f"make {target}",
                f"make {target}",
                self._script_category(target),
                "Makefile",
            )

        return commands[:24]

    def _node_runner(self, scan: ProjectScan) -> str:
        if scan.has("pnpm-lock.yaml") or scan.has("pnpm-workspace.yaml"):
            return "pnpm"
        if scan.has("yarn.lock"):
            return "yarn"
        if scan.has("bun.lockb"):
            return "bun"
        return "npm"

    def _script_category(self, name: str) -> str:
        lowered = name.lower()
        if "test" in lowered:
            return "test"
        if "lint" in lowered or "format" in lowered or "typecheck" in lowered:
            return "lint"
        if "build" in lowered or "package" in lowered or "compile" in lowered:
            return "build"
        if "install" in lowered or "setup" in lowered or "bootstrap" in lowered:
            return "setup"
        return "run"

    def _makefile_targets(self, scan: ProjectScan, *, limit: int = 6) -> list[str]:
        if not scan.has("Makefile"):
            return []
        targets: list[str] = []
        for line in scan.read("Makefile", max_chars=20_000).splitlines():
            match = re.match(r"^([a-zA-Z][\w-]*):(?!=)", line)
            if match and match.group(1) not in targets:
                targets.append(match.group(1))
            if len(targets) >= limit:
                break
        return targets

    # -- stats & prose -----------------------------------------------------

    def _collect_stats(self, scan: ProjectScan) -> dict[str, int]:
        code_files = scan.code_files
        test_files = [
            f
            for f in code_files
            if re.search(r"(^|/)(tests?|__tests__|spec)/", f)
            or re.search(r"(\.|_)(test|spec)s?\.", Path(f).name)
            or Path(f).name.endswith("Tests.cs")
        ]
        return {
            "files": len(scan.files),
            "code_files": len(code_files),
            "test_files": len(test_files),
            "directories": len(scan.dirs),
            "languages": len(self._language_counts(scan)),
        }

    def _getting_started(
        self, scan: ProjectScan, commands: list[ProjectCommand]
    ) -> str:
        steps: list[str] = ["## Getting Started\n"]
        ordered = [c for c in commands if c.category == "setup"]
        ordered += [c for c in commands if c.category == "build"][:1]
        ordered += [c for c in commands if c.category == "run"][:2]
        ordered += [c for c in commands if c.category == "test"][:1]
        if not ordered:
            steps.append("1. Check README.md for setup instructions")
            return "\n".join(steps)
        for index, command in enumerate(ordered[:8], start=1):
            steps.append(f"{index}. {command.label} — `{command.command}`")
        if scan.has(".env.example"):
            steps.append(
                f"{len(ordered[:8]) + 1}. Copy `.env.example` to `.env` and fill in the values"
            )
        return "\n".join(steps)

    def _architecture_text(self, nodes: list[ArchitectureNode]) -> str:
        if not nodes:
            return ""
        lines = ["## Architecture\n"]
        for node in nodes:
            langs = f" [{', '.join(node.languages)}]" if node.languages else ""
            lines.append(
                f"- `{node.path}/` — {node.role} ({node.file_count} files){langs}"
            )
        return "\n".join(lines)

    def _testing_text(self, scan: ProjectScan, commands: list[ProjectCommand]) -> str:
        test_commands = [c for c in commands if c.category == "test"]
        if not test_commands:
            return ""
        lines = ["## Testing\n"]
        for command in test_commands[:4]:
            lines.append(f"- `{command.command}` ({command.source})")
        return "\n".join(lines)

    def _dependencies_text(self, scan: ProjectScan) -> str:
        manifests = [
            name
            for name in (
                "package.json",
                "requirements.txt",
                "pyproject.toml",
                "Cargo.toml",
                "go.mod",
                "pom.xml",
                "Gemfile",
                "composer.json",
                "Directory.Packages.props",
            )
            if scan.has(name)
        ]
        manifests += scan.find("*.csproj", limit=3)
        if not manifests:
            return ""
        lines = ["## Dependencies\n"]
        for manifest in manifests:
            lines.append(f"- `{manifest}`")
        return "\n".join(lines)

    def _deployment_text(self, scan: ProjectScan) -> str:
        artefacts = [
            name
            for name in (
                "Dockerfile",
                "docker-compose.yml",
                "docker-compose.yaml",
                "Procfile",
                "fly.toml",
                "vercel.json",
                "netlify.toml",
                "helm",
                "k8s",
                "kubernetes",
                "terraform",
            )
            if scan.has(name)
        ]
        workflows = [f for f in scan.files if f.startswith(".github/workflows/")][:4]
        if not artefacts and not workflows:
            return ""
        lines = ["## Deployment\n"]
        for artefact in artefacts:
            lines.append(f"- `{artefact}`")
        for workflow in workflows:
            lines.append(f"- `{workflow}` (CI/CD)")
        return "\n".join(lines)
