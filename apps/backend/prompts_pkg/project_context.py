"""
Project Context Detection
=========================

Detects project capabilities from project_index.json to determine which
MCP tools and validation sections are relevant for the project.

This enables dynamic prompt assembly where QA agents only receive documentation
for tools relevant to their project type (Electron, Expo, Next.js, etc.),
saving context window and keeping agents focused.
"""

import json
from pathlib import Path


def load_project_index(project_dir: Path) -> dict:
    """
    Load project_index.json from the project's .workpilot directory.

    Args:
        project_dir: Root directory of the project

    Returns:
        Parsed project index dict, or empty dict if not found
    """
    index_file = project_dir / ".workpilot" / "project_index.json"
    if not index_file.exists():
        return {}

    try:
        with open(index_file, encoding="utf-8") as f:
            index = json.load(f)
    except (OSError, ValueError):  # unreadable, not UTF-8, or not JSON
        return {}
    return index if isinstance(index, dict) else {}


def _names(value) -> set[str]:
    """Lower-cased dependency names from a list, or from a name -> version map."""
    if not isinstance(value, (list, tuple, dict)):
        return set()
    return {dep.lower() for dep in value if isinstance(dep, str)}


def detect_project_capabilities(project_index: dict) -> dict:
    """
    Detect what MCP tools and validation types are relevant for this project.

    Analyzes the project_index.json to identify:
    - Desktop app frameworks (Electron, Tauri)
    - Mobile frameworks (Expo, React Native)
    - Web frontend frameworks (React, Vue, Next.js, etc.)
    - Backend capabilities (APIs, databases)

    Args:
        project_index: Parsed project_index.json dict

    Returns:
        Dictionary of capability flags:
        - is_electron: True if project uses Electron
        - is_tauri: True if project uses Tauri
        - is_expo: True if project uses Expo
        - is_react_native: True if project uses React Native
        - is_web_frontend: True if project has web frontend (React, Vue, etc.)
        - is_nextjs: True if project uses Next.js
        - is_nuxt: True if project uses Nuxt
        - has_api: True if project has API routes
        - has_database: True if project has database connections
    """
    capabilities = {
        # Desktop app frameworks
        "is_electron": False,
        "is_tauri": False,
        # Mobile frameworks
        "is_expo": False,
        "is_react_native": False,
        # Web frontend frameworks
        "is_web_frontend": False,
        "is_nextjs": False,
        "is_nuxt": False,
        # Backend capabilities
        "has_api": False,
        "has_database": False,
    }

    services = (
        project_index.get("services", {}) if isinstance(project_index, dict) else {}
    )

    # Handle both dict format (services by name) and list format
    if isinstance(services, dict):
        service_list = services.values()
    elif isinstance(services, list):
        service_list = services
    else:
        service_list = []

    for service in service_list:
        if not isinstance(service, dict):
            continue

        deps = _names(service.get("dependencies")) | _names(
            service.get("dev_dependencies")
        )

        # Get framework (normalize to lowercase)
        framework = str(service.get("framework", "")).lower()

        # Desktop app detection
        if "electron" in deps or any("@electron" in d for d in deps):
            capabilities["is_electron"] = True
        if "@tauri-apps/api" in deps or "tauri" in deps:
            capabilities["is_tauri"] = True

        # Mobile framework detection
        if "expo" in deps:
            capabilities["is_expo"] = True
        if "react-native" in deps:
            capabilities["is_react_native"] = True

        # Web frontend detection
        web_frameworks = ("react", "vue", "svelte", "angular", "solid")
        if framework in web_frameworks:
            capabilities["is_web_frontend"] = True

        # Meta-framework detection
        if framework in ("nextjs", "next.js", "next"):
            capabilities["is_nextjs"] = True
            capabilities["is_web_frontend"] = True
        if framework in ("nuxt", "nuxt.js"):
            capabilities["is_nuxt"] = True
            capabilities["is_web_frontend"] = True

        # Also check deps for framework indicators
        if "next" in deps:
            capabilities["is_nextjs"] = True
            capabilities["is_web_frontend"] = True
        if "nuxt" in deps:
            capabilities["is_nuxt"] = True
            capabilities["is_web_frontend"] = True
        if "vite" in deps and not capabilities["is_electron"]:
            # Vite usually indicates web frontend (unless Electron)
            capabilities["is_web_frontend"] = True

        # API detection
        api_info = service.get("api", {})
        if isinstance(api_info, dict) and api_info.get("routes"):
            capabilities["has_api"] = True

        # Database detection
        if service.get("database"):
            capabilities["has_database"] = True
        # Also check for ORM/database deps
        db_deps = {
            "prisma",
            "drizzle-orm",
            "typeorm",
            "sequelize",
            "mongoose",
            "sqlalchemy",
            "alembic",
            "django",
            "peewee",
        }
        if deps & db_deps:
            capabilities["has_database"] = True

    return capabilities


_DEPENDENCY_FILES = (
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Gemfile",
    "go.mod",
    "Cargo.toml",
    "composer.json",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "pubspec.yaml",
    "Package.swift",
    "mix.exs",
)
_NOT_A_SERVICE = ("node_modules", "__pycache__", "dist", "build")


def should_refresh_project_index(project_dir: Path) -> bool:
    """
    Check if project_index.json needs refresh based on dependency file changes.

    Uses smart caching: only refresh if dependency files (package.json,
    pyproject.toml, etc.) have been modified since the last index generation.

    Args:
        project_dir: Root directory of the project

    Returns:
        True if index should be regenerated, False if cache is still valid
    """
    index_file = project_dir / ".workpilot" / "project_index.json"

    try:
        index_mtime = index_file.stat().st_mtime
    except OSError:
        return True  # No index, or one we can't inspect: (re)generate

    # The project's own dependency files, then each first-level service's
    # (monorepos), whatever the language.
    folders = [project_dir]
    try:
        folders += [
            sub
            for sub in project_dir.iterdir()
            if sub.is_dir()
            and not sub.name.startswith(".")
            and sub.name not in _NOT_A_SERVICE
        ]
    except OSError:
        pass  # Can't list the folder: judge on the root files alone

    for folder in folders:
        for name in _DEPENDENCY_FILES:
            try:
                if (folder / name).stat().st_mtime > index_mtime:
                    return True  # Dependency file changed, refresh needed
            except OSError:
                continue  # Missing or unreadable

    return False  # Cache is fresh


def get_mcp_tools_for_project(capabilities: dict) -> list[str]:
    """
    Get list of MCP tool documentation files to include based on capabilities.

    Args:
        capabilities: Dict from detect_project_capabilities()

    Returns:
        List of prompt file paths (relative to prompts/) to include
    """
    tools = []

    # Desktop app validation (Tauri has no MCP tool doc: none is wired)
    if capabilities.get("is_electron"):
        tools.append("mcp_tools/electron_validation.md")

    # Web browser automation (for non-Electron web apps)
    if capabilities.get("is_web_frontend") and not capabilities.get("is_electron"):
        tools.append("mcp_tools/puppeteer_browser.md")

    # Database validation
    if capabilities.get("has_database"):
        tools.append("mcp_tools/database_validation.md")

    # API testing
    if capabilities.get("has_api"):
        tools.append("mcp_tools/api_validation.md")

    return tools
