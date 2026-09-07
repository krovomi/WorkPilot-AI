"""
Message catalogue for the generated onboarding content.

The onboarding package is *data*, but almost all of it is prose a newcomer
reads: why a file matters, what a directory holds, what a quiz is asking. That
prose was written in English inside the generators, so a French UI rendered an
English package — the i18n rule of the repository stops at the components, and
everything below them leaked through.

So a generated string is emitted twice: as English text (the CLI's markdown
render, and the fallback) and as a :class:`Text` descriptor — an i18n key plus
its parameters — which the UI resolves through ``react-i18next``. Switching the
app's language re-renders the package; it does not re-scan the project.

The catalogue here is the single source of the English side. Keys live under
``onboardingAgent:generated.*`` in the locale files, and
``tests/backend/test_onboarding_i18n.py`` fails when the three drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

_PREFIX = "generated."


@dataclass
class Text:
    """One translatable generated string.

    ``key`` is relative to the ``onboardingAgent`` namespace. ``params`` may
    hold scalars or nested :class:`Text` values — a quiz question quoting the
    role of a directory needs that role translated too, not pasted in English.
    """

    key: str
    params: dict[str, Any] = field(default_factory=dict)
    fallback: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "params": {
                name: value.to_dict() if isinstance(value, Text) else value
                for name, value in self.params.items()
            },
            "fallback": self.fallback,
        }


class UnknownMessage(KeyError):
    """Raised when a generator asks for a key the catalogue does not define."""


def text(key: str, /, **params: Any) -> Text:
    """Build a :class:`Text` for ``key``, rendering its English fallback."""
    template = CATALOGUE.get(key)
    if template is None:
        raise UnknownMessage(key)
    rendered = {
        name: (value.fallback if isinstance(value, Text) else value)
        for name, value in params.items()
    }
    try:
        fallback = template.format(**rendered)
    except (KeyError, IndexError) as exc:  # pragma: no cover - programming error
        raise UnknownMessage(f"{key}: missing parameter {exc}") from exc
    return Text(key=f"{_PREFIX}{key}", params=params, fallback=fallback)


def raw(value: str) -> Text:
    """Wrap a value that is not translatable — a path, a command, a term."""
    return Text(key="", params={}, fallback=value)


# ---------------------------------------------------------------------------
# Catalogue
# ---------------------------------------------------------------------------

CATALOGUE: dict[str, str] = {
    # -- key files ---------------------------------------------------------
    "keyFile.readme": "Project documentation entry point",
    "keyFile.contributing": "Contribution guidelines",
    "keyFile.architecture": "Architecture overview",
    "keyFile.agents": "Instructions for coding agents",
    "keyFile.claude": "Instructions for Claude Code",
    "keyFile.changelog": "Release history",
    "keyFile.security": "Security policy",
    "keyFile.codeOfConduct": "Community rules",
    "keyFile.license": "License terms",
    "keyFile.packageJson": "Node.js dependencies and scripts",
    "keyFile.pnpmWorkspace": "pnpm workspace layout",
    "keyFile.tsconfig": "TypeScript compiler configuration",
    "keyFile.pyproject": "Python project configuration",
    "keyFile.requirements": "Python dependencies",
    "keyFile.cargo": "Rust crate manifest",
    "keyFile.goMod": "Go module definition",
    "keyFile.pom": "Maven build definition",
    "keyFile.gradle": "Gradle build definition",
    "keyFile.gemfile": "Ruby dependencies",
    "keyFile.composer": "PHP dependencies",
    "keyFile.directoryPackages": "Centrally managed NuGet versions",
    "keyFile.globalJson": "Pinned .NET SDK version",
    "keyFile.appsettings": "Runtime application settings",
    "keyFile.envExample": "Environment variables template",
    "keyFile.dockerCompose": "Service orchestration",
    "keyFile.dockerfile": "Container image definition",
    "keyFile.makefile": "Task entry points",
    "keyFile.solution": "Solution grouping every .NET project",
    "keyFile.ciWorkflow": "Continuous integration pipeline",
    "keyFile.largestInDirectory": (
        "Largest source file of `{directory}` ({lines} lines) — usually where "
        "that area's logic lives"
    ),
    # -- entry points ------------------------------------------------------
    "entryPoint.programCs": "Application entry point and host configuration",
    "entryPoint.startupCs": "Service registration and HTTP pipeline configuration",
    "entryPoint.pythonMain": "Python entry point",
    "entryPoint.application": "Application entry point",
    "entryPoint.djangoManage": "Django management entry point",
    "entryPoint.runtime": "Runtime entry point",
    "entryPoint.pythonModule": "Module executed with `python -m`",
    "entryPoint.goMain": "Go entry point",
    "entryPoint.rustMain": "Rust entry point",
    "entryPoint.javaMain": "Java entry point",
    "entryPoint.flutterMain": "Flutter entry point",
    "entryPoint.module": "Module entry point",
    "entryPoint.bootstrap": "Application bootstrap",
    "entryPoint.uiBootstrap": "UI bootstrap",
    "entryPoint.reactRoot": "Root React component",
    "entryPoint.httpServer": "HTTP server bootstrap",
    # -- directory roles ---------------------------------------------------
    "role.controllers": "HTTP entry points (controllers)",
    "role.endpoints": "HTTP endpoints",
    "role.infrastructure": "Infrastructure layer — persistence, external services",
    "role.persistence": "Persistence layer",
    "role.application": "Application layer — use cases and orchestration",
    "role.domain": "Domain layer — entities and business rules",
    "role.usecases": "Use cases",
    "role.handlers": "Request/command handlers",
    "role.repositories": "Data access repositories",
    "role.migrations": "Database schema migrations",
    "role.entities": "Domain entities",
    "role.models": "Data models",
    "role.dtos": "Data transfer objects",
    "role.contracts": "Shared contracts and interfaces",
    "role.interfaces": "Abstractions and interfaces",
    "role.services": "Business services",
    "role.components": "UI components",
    "role.hooks": "Reusable UI hooks",
    "role.stores": "Client-side state stores",
    "role.pages": "Routed pages",
    "role.views": "Views",
    "role.routes": "Route definitions",
    "role.middleware": "Request middleware",
    "role.config": "Configuration",
    "role.scripts": "Automation and build scripts",
    "role.tools": "Developer tooling",
    "role.docs": "Documentation",
    "role.tests": "Automated tests",
    "role.e2e": "End-to-end tests",
    "role.fixtures": "Test fixtures",
    "role.assets": "Static assets",
    "role.public": "Publicly served static files",
    "role.static": "Static files",
    "role.locales": "Translations",
    "role.api": "API surface",
    "role.cli": "Command-line interface",
    "role.core": "Core building blocks",
    "role.shared": "Code shared across modules",
    "role.utils": "Utilities",
    "role.lib": "Library code",
    "role.src": "Application source",
    "role.app": "Application code",
    "role.apps": "Applications of the monorepo",
    "role.packages": "Packages of the monorepo",
    "role.server": "Server-side code",
    "role.client": "Client-side code",
    "role.frontend": "Frontend application",
    "role.backend": "Backend application",
    "role.mobile": "Mobile application",
    "role.infra": "Infrastructure as code",
    "role.deploy": "Deployment manifests",
    "role.ci": "CI/CD workflows and repository automation",
    "role.unknown": "Project code",
    # -- conventions -------------------------------------------------------
    "convention.tool.description": "{purpose} — configured via `{file}`",
    "convention.purpose.eslint": "JavaScript/TypeScript linting",
    "convention.purpose.biome": "Formatting and linting",
    "convention.purpose.prettier": "Code formatting",
    "convention.purpose.ruff": "Python linting and formatting",
    "convention.purpose.flake8": "Python linting",
    "convention.purpose.setupCfg": "Python tooling configuration",
    "convention.purpose.mypy": "Python static typing",
    "convention.purpose.editorconfig": "Editor-level formatting rules",
    "convention.purpose.csharpier": "C# formatting",
    "convention.purpose.roslyn": "C# analyzer rules",
    "convention.purpose.stylecop": "C# style rules",
    "convention.purpose.golangci": "Go linting",
    "convention.purpose.rustfmt": "Rust formatting",
    "convention.purpose.clippy": "Rust linting",
    "convention.purpose.rubocop": "Ruby linting",
    "convention.purpose.preCommit": "Hooks run before each commit",
    "convention.purpose.commitlint": "Commit message convention",
    "convention.purpose.lefthook": "Git hooks",
    "convention.scriptedFormatting.name": "Formatting is scripted",
    "convention.scriptedFormatting.description": (
        "Run the project's own script rather than your editor's defaults."
    ),
    "convention.fileNaming.name": "File names use {style}",
    "convention.fileNaming.description": (
        "{count} of {total} source files follow it — match it for new files."
    ),
    "convention.tests.name": "Tests live as {pattern}",
    "convention.tests.description": (
        "{count} matching file(s) — put new tests where the existing ones are."
    ),
    "convention.testPattern.directory": "tests/ directory",
    "convention.testPattern.beside": "*.test.ts / *.spec.ts beside the code",
    "convention.testPattern.python": "test_*.py",
    "convention.testPattern.dotnet": "*Tests.cs",
    "convention.testPattern.go": "*_test.go",
    "convention.indentation.name": "Indentation: {style}",
    "convention.indentation.description": (
        "Measured on the existing sources; the formatter enforces it."
    ),
    "convention.indentation.tabs": "tabs",
    "convention.indentation.spaces": "4 spaces",
    "convention.pullRequest.name": "Pull request template",
    "convention.pullRequest.description": (
        "Every PR is expected to fill the repository's template."
    ),
    # -- commands ----------------------------------------------------------
    "command.installDependencies": "Install dependencies",
    "command.createVenv": "Create the virtual environment",
    "command.installProject": "Install the project",
    "command.runTests": "Run the tests",
    "command.restorePackages": "Restore packages",
    "command.buildSolution": "Build the solution",
    "command.build": "Build",
    "command.runProject": "Run {project}",
    "command.startServices": "Start the services",
    # -- tour --------------------------------------------------------------
    "tour.reason.directory": "{role} — {count} files",
    "tour.reason.directoryLanguages": "{role} — {count} files, mostly {languages}",
    "tour.question.docPurpose": "What does {path} say the project is for?",
    "tour.question.docClaims": "Which claims in it does the code actually back up?",
    "tour.question.entryWiring": "What is wired up when {path} runs?",
    "tour.question.entryDependencies": (
        "Which dependencies are registered here, and where are they used?"
    ),
    "tour.question.directoryBelongs": "What belongs in {path}/ and what does not?",
    "tour.question.directoryLayer": "Which layer does {path}/ depend on?",
    "tour.question.configBreakage": "What would break if {path} were wrong?",
    "tour.question.configEnvironments": (
        "Which values here differ between environments?"
    ),
    "tour.question.sourceProblem": "What problem does {path} solve?",
    "tour.question.sourceDependents": (
        "Which other files in {project} depend on {path}?"
    ),
    "tour.question.ciChecks": "Which checks must pass before a PR can merge?",
    "tour.question.ciLocal": "Can you run those same checks locally?",
    # -- quiz --------------------------------------------------------------
    "quiz.primaryTech.question": "What is the primary technology of {project}?",
    "quiz.primaryTech.rationale": "Detected from the project files: {stack}",
    "quiz.notInStack.question": "Which of these is NOT part of this project's stack?",
    "quiz.notInStack.rationale": "The detected stack is: {stack}",
    "quiz.entryPoint.question": "Where does the application start executing?",
    "quiz.filePurpose.question": "Which file's purpose is: “{reason}”?",
    "quiz.filePurpose.rationale": "`{path}` — {reason}",
    "quiz.fileRole.question": "What is the role of `{path}`?",
    "quiz.directoryHolds.question": "What does `{path}/` hold?",
    "quiz.directoryHolds.rationale": "`{path}/` — {role} ({count} files)",
    "quiz.command.test": "Which command runs the test suite?",
    "quiz.command.setup": "Which command installs the project's dependencies?",
    "quiz.command.build": "Which command builds the project?",
    "quiz.command.lint": "Which command checks formatting and lint rules?",
    "quiz.command.rationale": "`{command}` — from {source}",
    "quiz.command.unknownSource": "the project manifest",
    "quiz.convention.question": "Which convention does {project} follow?",
    "quiz.convention.noLinter": "No linter is configured",
    "quiz.convention.perDeveloper": "Formatting is left to each developer",
    "quiz.convention.afterRelease": "Tests are written after release",
    "quiz.testLocation.question": "Where does a new test file belong?",
    "quiz.testLocation.rationale": "{description} e.g. {examples}",
    "quiz.testLocation.root": "Anywhere in the repository root",
    "quiz.testLocation.buildOutput": "Inside the build output directory",
    "quiz.testLocation.personalFolder": "In a personal folder outside the repository",
    "quiz.tourRecall.question": "During the tour, why does `{path}` matter?",
    # -- first tasks -------------------------------------------------------
    "firstTask.todo.title": "{tag}: {note}",
    "firstTask.todo.why": "Left in the code by the team — a scoped, real change.",
    "firstTask.tests.title": "Add a first test for {file}",
    "firstTask.tests.comment": "{lines} lines, no test file matching its name",
    "firstTask.tests.why": (
        "Reading a file closely enough to test it is the fastest way to learn it."
    ),
    "firstTask.docs.title": "Document what {file} wires up",
    "firstTask.docs.comment": "Entry point with no header comment",
    "firstTask.docs.why": (
        "Writing it down forces you to follow the startup path once."
    ),
    "firstTask.readme.title": "Document how to run the project",
    "firstTask.readme.comment": "No install/run/test command could be detected",
    "firstTask.readme.why": "Nothing in the repository states how to start it.",
    "firstTask.explore.title": "Map the dependencies of {path}/",
    "firstTask.explore.comment": "{role} — {count} files",
    "firstTask.explore.why": ("Draw what this directory imports and what imports it."),
    # -- glossary ----------------------------------------------------------
    "glossary.directory": "Directory of the project",
    "glossary.type": "Type declared in `{path}`",
    "glossary.typeGeneric": "Type declared in the codebase",
    "glossary.module": "Appears in the name of {count} file(s)",
    "glossary.moduleGeneric": "File name token",
    "glossary.identifier": "Recurring identifier — likely domain vocabulary",
    # -- guide steps (the Onboarding Guide page) ---------------------------
    "step.keyFiles.title": "Key files to read first",
    "step.gettingStarted.title": "Getting started",
    "step.architecture.title": "How the project is laid out",
    "step.conventions.title": "Coding conventions",
    "step.workflows.title": "Day-to-day commands",
    "step.testing.title": "Running the tests",
    "step.deployment.title": "How it ships",
    "step.line.keyFile": "{path}: {reason}",
    "step.line.command": "{label}: `{command}`",
    "step.line.architecture": "`{path}/` — {role} ({count} files)",
    "step.line.convention": "{name}: {description}",
    "step.line.envExample": "Copy `.env.example` to `.env` and fill in the values",
    "step.line.readmeFallback": "Check README.md for setup instructions",
    "step.line.testCommand": "`{command}` ({source})",
    "step.line.manifest": "`{path}`",
    "step.line.deployment": "`{path}`",
    "step.line.ciWorkflow": "`{path}` (CI/CD)",
    # -- progress ----------------------------------------------------------
    "progress.analyzing": "Analyzing project structure…",
    "progress.generated": (
        "Generated {tour} tour step(s), {quiz} quiz question(s), "
        "{tasks} first task(s), {glossary} glossary term(s)"
    ),
    "summary": (
        "{project}: {technologies} technologies, {keyFiles} key files, "
        "{conventions} conventions, {commands} commands."
    ),
}
