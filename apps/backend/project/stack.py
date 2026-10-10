"""What is this project built with — one door for every reader.

The question was answered in at least eleven places (audit F26), each with
its own vocabulary because each serves a different consumer: the CI pipeline
generator wants manifests and package managers, the subagent overlays want
languages, the API test drafts want an HTTP framework, the validation
strategy wants an application type. Those answers stay distinct — a
`react_spa` and a `["javascript/typescript"]` are both right — but they are
asked here, so a new reader picks an existing answer instead of writing a
twelfth detector.

What is behind the door:

``technology_stack`` / ``frameworks``
    `StackDetector` and `FrameworkDetector`: every language and framework the
    tree shows, for the security profile and anything that wants breadth.
``detect_project_stack`` / ``detect_languages``
    Manifests at the root (``.csproj`` one level down): languages, package
    managers, test runners, Docker, existing CI. What the subagent overlays
    and the pipeline generator read; ``detect_languages`` caches per project.
``detect_project_type``
    The application kind the validation strategy is chosen by.
``detect_markers``
    Which of a caller's marker rules appear anywhere in the tree — the flaky
    test scan's "which test report does this stack emit".
``detect_api_stack``
    The HTTP framework (ASP.NET Core, Spring, FastAPI…), for API test drafts
    and the verify loop's endpoints.
``ui_stack`` / ``mobile_stack`` / ``test_profile``
    `uiux.stack`, `mobile.stacks` and `test_generation.stack_aware`, imported
    lazily: they are packages of their own with readers inside them, and
    importing them here must not drag them into every import of this module.

Every function degrades to an empty answer rather than raising on an
unreadable tree; the callers treat "unknown" as "no specialisation".
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "detect_api_stack",
    "detect_languages",
    "detect_markers",
    "detect_project_stack",
    "detect_project_type",
    "frameworks",
    "mobile_stack",
    "technology_stack",
    "test_profile",
    "ui_stack",
]

# Stack detection touches the filesystem; the answer does not change during a
# run, and create_client is called once per phase.
_STACK_CACHE: dict[str, list[str]] = {}


def detect_markers(
    project_dir: Path | str,
    rules: list[tuple[str, tuple[str, ...]]],
    ignores: set[str] | frozenset[str] = frozenset(),
    max_files: int = 20000,
) -> list[str]:
    """Labels of ``rules`` whose markers appear anywhere in the tree, in order.

    A marker is a file name (``go.mod``) or an extension glob (``*.csproj``).
    One pruned walk serves every rule, and it stops once ``max_files`` names
    have been seen: enough to identify a stack on a very large monorepo.
    """
    filenames: set[str] = set()
    extensions: set[str] = set()
    for _dirpath, dirnames, files in os.walk(project_dir):
        dirnames[:] = [d for d in dirnames if d not in ignores]
        for name in files:
            filenames.add(name)
            extensions.add(Path(name).suffix.lower())
        if len(filenames) > max_files:
            break

    def _hit(marker: str) -> bool:
        if marker.startswith("*."):
            return marker[1:].lower() in extensions
        return marker in filenames

    return [label for label, markers in rules if any(_hit(m) for m in markers)]


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def technology_stack(project_dir: Path | str) -> Any:
    """Every language, package manager, database… the tree shows (`TechnologyStack`)."""
    from .stack_detector import StackDetector

    return StackDetector(Path(project_dir)).detect_all()


def frameworks(project_dir: Path | str) -> list[str]:
    """Frameworks named by the project's manifests (`FrameworkDetector`)."""
    from .framework_detector import FrameworkDetector

    return FrameworkDetector(Path(project_dir)).detect_all()


def ui_stack(project_dir: Path | str | None) -> Any:
    """The UI toolkits and their design guides (`uiux.stack.UiStack`)."""
    from uiux.stack import detect_ui_stack

    return detect_ui_stack(project_dir)


def mobile_stack(project_dir: Path | str | None) -> Any:
    """The phone-app stack and its commands (`mobile.stacks.MobileStack`), or None."""
    from mobile.stacks import detect_stack

    return detect_stack(project_dir)


def test_profile(project_dir: Path | str) -> Any:
    """Test frameworks and API frameworks per language (`StackProfile`)."""
    from test_generation.stack_aware import detect_stack

    return detect_stack(project_dir)


def detect_project_stack(project_dir: Path) -> dict:
    """Detect tech stack, test runners, and existing CI configs."""
    stack = {
        "languages": [],
        "package_managers": [],
        "frameworks": [],
        "test_runners": [],
        "has_docker": False,
        "has_docker_compose": False,
        "existing_ci": [],
        "build_scripts": [],
    }

    # Language/framework detection
    if (project_dir / "package.json").exists():
        stack["languages"].append("javascript/typescript")
        stack["package_managers"].append("npm")
        try:
            pkg = json.loads((project_dir / "package.json").read_text(encoding="utf-8"))
            scripts = pkg.get("scripts", {})
            if "test" in scripts:
                stack["test_runners"].append(scripts["test"])
            if "build" in scripts:
                stack["build_scripts"].append(scripts["build"])
            deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
            if "react" in deps:
                stack["frameworks"].append("react")
            if "next" in deps:
                stack["frameworks"].append("nextjs")
            if "vue" in deps:
                stack["frameworks"].append("vue")
            if "jest" in deps:
                stack["test_runners"].append("jest")
            if "vitest" in deps:
                stack["test_runners"].append("vitest")
            if "playwright" in deps or "@playwright/test" in deps:
                stack["test_runners"].append("playwright")
            if "pnpm" in deps or (project_dir / "pnpm-lock.yaml").exists():
                stack["package_managers"].append("pnpm")
            if (project_dir / "yarn.lock").exists():
                stack["package_managers"].append("yarn")
        except Exception:
            pass

    if (project_dir / "requirements.txt").exists() or (
        project_dir / "pyproject.toml"
    ).exists():
        stack["languages"].append("python")
        if (project_dir / "pyproject.toml").exists():
            stack["package_managers"].append("uv/poetry/pip")
        else:
            stack["package_managers"].append("pip")

    if (project_dir / "Cargo.toml").exists():
        stack["languages"].append("rust")
        stack["package_managers"].append("cargo")

    # .NET. Project files can sit in subdirectories next to a solution at the
    # root, which is the usual layout, so a root-only check misses most repos.
    dotnet_projects = (
        list(project_dir.glob("*.sln")) or list(project_dir.glob("**/*.csproj"))[:50]
    )
    if dotnet_projects:
        stack["languages"].append("c#")
        stack["package_managers"].append("nuget")
        stack["test_runners"].append("dotnet test")

    if (project_dir / "go.mod").exists():
        stack["languages"].append("go")
        stack["package_managers"].append("go mod")

    if (project_dir / "pom.xml").exists():
        stack["languages"].append("java/kotlin")
        stack["package_managers"].append("maven")

    if (project_dir / "build.gradle").exists() or (
        project_dir / "build.gradle.kts"
    ).exists():
        stack["languages"].append("java/kotlin")
        stack["package_managers"].append("gradle")

    # Docker
    if (project_dir / "Dockerfile").exists():
        stack["has_docker"] = True
    if (project_dir / "docker-compose.yml").exists() or (
        project_dir / "docker-compose.yaml"
    ).exists():
        stack["has_docker_compose"] = True

    # Existing CI configs
    if (project_dir / ".github" / "workflows").exists():
        stack["existing_ci"].append("github_actions")
    if (project_dir / ".gitlab-ci.yml").exists():
        stack["existing_ci"].append("gitlab_ci")
    if (project_dir / ".circleci" / "config.yml").exists():
        stack["existing_ci"].append("circleci")

    # Deduplicate
    for key in ["languages", "package_managers", "frameworks", "test_runners"]:
        stack[key] = list(set(stack[key]))

    return stack


def detect_project_type(project_dir: Path) -> str:
    """
    Detect the project type based on files and dependencies.

    Args:
        project_dir: Path to the project directory

    Returns:
        Project type string (e.g., "react_spa", "python_api", "nodejs")
    """
    project_dir = Path(project_dir)

    # Check for specific frameworks first
    package_json = project_dir / "package.json"
    if package_json.exists():
        try:
            with open(package_json, encoding="utf-8") as f:
                pkg = json.load(f)
            deps = pkg.get("dependencies", {})
            dev_deps = pkg.get("devDependencies", {})
            all_deps = {**deps, **dev_deps}

            if "electron" in all_deps:
                return "electron"
            if "next" in all_deps:
                return "nextjs"
            if "react" in all_deps:
                return "react_spa"
            if "vue" in all_deps:
                return "vue_spa"
            if "@angular/core" in all_deps:
                return "angular_spa"
            return "nodejs"
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return "nodejs"

    # Check for Python projects
    pyproject = project_dir / "pyproject.toml"
    requirements = project_dir / "requirements.txt"
    if pyproject.exists() or requirements.exists():
        # Try to detect API framework
        deps_text = ""
        if requirements.exists():
            deps_text = requirements.read_text(encoding="utf-8").lower()
        if pyproject.exists():
            deps_text += pyproject.read_text(encoding="utf-8").lower()

        if "fastapi" in deps_text or "flask" in deps_text or "django" in deps_text:
            return "python_api"
        if "click" in deps_text or "typer" in deps_text or "argparse" in deps_text:
            return "python_cli"
        return "python"

    # Check for other languages
    if (project_dir / "Cargo.toml").exists():
        return "rust"
    if (project_dir / "go.mod").exists():
        return "go"
    if (project_dir / "Gemfile").exists():
        return "ruby"

    # Check for simple HTML/CSS
    html_files = list(project_dir.glob("*.html"))
    if html_files:
        return "html_css"

    return "unknown"


def detect_api_stack(project_dir: Path) -> tuple[str, str]:
    """(stack, language) of the project's HTTP API, or ("", "")."""
    from test_generation.stack_aware import detect_stack, iter_project_files

    profile = detect_stack(project_dir)
    if profile.aspnet:
        return "aspnetcore", "csharp"
    for manifest in iter_project_files(
        project_dir, ("pom.xml", "build.gradle", "build.gradle.kts")
    ):
        if "spring-boot" in _read(manifest):
            return "spring", "java"
    if profile.python_api_framework:
        return profile.python_api_framework.lower(), "python"
    if profile.node_api_framework:
        return "node", "typescript"
    if (project_dir / "go.mod").is_file():
        return "go", "go"
    return "", ""


def detect_languages(project_dir: Path | str | None) -> list[str]:
    """Languages present in ``project_dir``, or [] when it cannot be determined.

    Reads ``detect_project_stack`` rather than adding another stack detector
    to this repo. Import failures degrade to "no overlay", never to an error:
    a missing specialisation is a worse roster, a raised exception is a broken
    build.
    """
    if not project_dir:
        return []
    key = str(Path(project_dir).resolve())
    if key in _STACK_CACHE:
        return _STACK_CACHE[key]

    languages: list[str] = []
    try:
        languages = list(detect_project_stack(Path(key)).get("languages") or [])
    except Exception as exc:
        logger.debug("stack detection unavailable for %s: %s", key, exc)

    _STACK_CACHE[key] = languages
    return languages
