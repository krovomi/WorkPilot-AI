"""
Stack Analyzer: Detects and analyzes technology stacks.
"""

import json
import os
import re
import tomllib
from collections.abc import Iterator
from pathlib import Path

from .models import StackInfo

#: Directories never read: dependencies, virtualenvs, build output, and the
#: task worktrees under `.workpilot/`, each a full copy of the project. A walk
#: into `node_modules` or `.venv` counted their files as the project's own
#: language and took minutes on a real project.
_SKIPPED_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".workpilot",
        ".venv",
        "venv",
        "env",
        "__pycache__",
        "node_modules",
        "bower_components",
        "dist",
        "build",
        "out",
        "target",
        "vendor",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
    }
)


class StackAnalyzer:
    """Analyzes technology stacks in a project."""

    def __init__(self, project_dir: str):
        self.project_dir = Path(project_dir)
        self.cache: dict = {}

    def detect_stack(self) -> StackInfo:
        """Detect the technology stack of the project."""
        framework = self._detect_framework()
        language = self._detect_language()
        version = self._detect_version(framework, language)
        database = self._detect_database()
        db_version = self._detect_db_version(database) if database else None
        dependencies = self._extract_dependencies()
        additional_tools = self._detect_tools()
        package_manager = self._detect_package_manager()

        return StackInfo(
            framework=framework,
            language=language,
            version=version,
            database=database,
            db_version=db_version,
            dependencies=dependencies,
            additional_tools=additional_tools,
            package_manager=package_manager,
        )

    def _detect_framework(self) -> str:
        """Detect primary framework (React, Vue, Django, etc.)."""
        # Check for frontend frameworks
        if self._check_file_exists("node_modules/react"):
            return "react"
        if self._check_file_exists("node_modules/vue"):
            return "vue"
        if self._check_file_exists("node_modules/@angular/core"):
            return "angular"
        if self._check_file_exists("node_modules/svelte"):
            return "svelte"

        # Check package.json
        package_json = self._read_package_json()
        if package_json:
            deps = {
                **package_json.get("dependencies", {}),
                **package_json.get("devDependencies", {}),
            }
            if "react" in deps:
                return "react"
            if "vue" in deps:
                return "vue"
            if "@angular/core" in deps:
                return "angular"
            if "svelte" in deps:
                return "svelte"

        # Check for backend frameworks
        if self._check_file_exists("requirements.txt") or self._check_file_exists(
            "pyproject.toml"
        ):
            reqs = self._python_requirements_text()
            if "django" in reqs.lower():
                return "django"
            if "flask" in reqs.lower():
                return "flask"
            if "fastapi" in reqs.lower():
                return "fastapi"
            return "python"  # Default Python framework

        # Check for Node.js backends
        if package_json:
            deps = {
                **package_json.get("dependencies", {}),
                **package_json.get("devDependencies", {}),
            }
            if "express" in deps:
                return "express"
            if "fastify" in deps:
                return "fastify"
            if "koa" in deps:
                return "koa"
            return "nodejs"  # Default Node.js

        return "unknown"

    def _detect_language(self) -> str:
        """Detect primary programming language."""
        # Check for TypeScript
        if self._check_file_exists("tsconfig.json"):
            return "typescript"

        # Check for Python
        if self._check_file_exists("setup.py") or self._check_file_exists(
            "pyproject.toml"
        ):
            return "python"

        # Check for Java
        if self._check_file_exists("pom.xml") or self._check_file_exists(
            "build.gradle"
        ):
            return "java"

        # Check for Go
        if self._check_file_exists("go.mod"):
            return "go"

        # Check for Rust
        if self._check_file_exists("Cargo.toml"):
            return "rust"

        # Check file extensions
        languages = {
            ".py": "python",
            ".js": "javascript",
            ".jsx": "javascript",
            ".ts": "typescript",
            ".tsx": "typescript",
            ".java": "java",
            ".go": "go",
            ".rs": "rust",
        }
        counts = dict.fromkeys(languages.values(), 0)
        for path in self._project_files():
            language = languages.get(path.suffix)
            if language:
                counts[language] += 1

        if max(counts.values()) == 0:
            return "unknown"

        return max(counts, key=counts.get)

    def _detect_version(self, framework: str, language: str) -> str:
        """Detect framework/language version."""
        # Python version
        if language == "python":
            if self._check_python_version_file("python2"):
                return "2.7"
            # Default to 3.x
            pyproject = self._read_pyproject_toml()
            if pyproject:
                requires_python = pyproject.get("project", {}).get("requires-python")
                if requires_python:
                    return self._parse_version_spec(requires_python)
            return "3.8"

        # TypeScript version
        if language == "typescript":
            tsconfig = self._read_tsconfig()
            if tsconfig is not None:
                return tsconfig.get("compilerOptions", {}).get("target", "es2020")

        # Package.json based detection
        package_json = self._read_package_json()
        if package_json:
            if framework == "react":
                return package_json.get("dependencies", {}).get("react", "unknown")
            if framework == "vue":
                return package_json.get("dependencies", {}).get("vue", "unknown")
            if language == "typescript":
                return package_json.get("devDependencies", {}).get(
                    "typescript", "unknown"
                )

        return "unknown"

    def _detect_database(self) -> str | None:
        """Detect database technology."""
        package_json = self._read_package_json()
        if package_json:
            deps = {
                **package_json.get("dependencies", {}),
                **package_json.get("devDependencies", {}),
            }
            if "mysql" in deps or "mysql2" in deps:
                return "mysql"
            if "pg" in deps or "postgres" in deps or "postgresql" in deps:
                return "postgresql"
            if "mongodb" in deps:
                return "mongodb"
            if "redis" in deps:
                return "redis"

        # Check the Python dependencies
        reqs = self._python_requirements_text()
        if reqs:
            if "mysql" in reqs.lower() or "mysqlclient" in reqs.lower():
                return "mysql"
            if "psycopg" in reqs.lower() or "postgresql" in reqs.lower():
                return "postgresql"
            if "pymongo" in reqs.lower():
                return "mongodb"
            if "redis" in reqs.lower():
                return "redis"

        # Check for SQL files
        sql_files = [f for f in self._project_files() if f.suffix == ".sql"][:5]
        # A dump is not always UTF-8: an undecodable byte must not stop the
        # analysis (it made the page report the migration as unsupported).
        content = "\n".join(
            f.read_text(encoding="utf-8", errors="replace") for f in sql_files
        )
        if "PRAGMA" in content or "sqlite" in content.lower():
            return "sqlite"

        return None

    def _detect_db_version(self, database: str | None) -> str | None:
        """Detect database version."""
        if not database:
            return None

        package_json = self._read_package_json()
        if package_json:
            deps = {
                **package_json.get("dependencies", {}),
                **package_json.get("devDependencies", {}),
            }
            if database == "mysql":
                return deps.get("mysql") or deps.get("mysql2")
            if database == "postgresql":
                return deps.get("pg") or deps.get("postgres")

        reqs = self._read_requirements_txt()
        if reqs:
            for line in reqs.split("\n"):
                if database in line.lower():
                    return self._extract_version_from_requirement(line)

        return None

    def _extract_dependencies(self) -> dict[str, str]:
        """Extract all project dependencies."""
        dependencies = {}

        # From package.json
        package_json = self._read_package_json()
        if package_json:
            dependencies.update(package_json.get("dependencies", {}))
            dependencies.update(package_json.get("devDependencies", {}))

        # From requirements.txt
        reqs = self._read_requirements_txt()
        if reqs:
            for line in reqs.split("\n"):
                line = line.strip()
                if line and not line.startswith("#"):
                    name = re.split(r"[=<>!~]", line)[0].strip()
                    dependencies[name] = self._extract_version_from_requirement(line)

        # Limit to top dependencies to avoid bloat
        sorted_deps = sorted(dependencies.items())[:30]
        return dict(sorted_deps)

    def _detect_tools(self) -> list[str]:
        """Detect build tools and additional frameworks."""
        tools = []

        # Check for webpack
        if self._check_file_exists("webpack.config.js"):
            tools.append("webpack")
        # Check for vite
        if self._check_file_exists("vite.config.js"):
            tools.append("vite")
        # Check for babel
        if self._check_file_exists(".babelrc") or self._check_file_exists(
            "babel.config.js"
        ):
            tools.append("babel")
        # Check for docker
        if self._check_file_exists("Dockerfile"):
            tools.append("docker")
        # Check for k8s
        if self._check_file_exists("k8s"):
            tools.append("kubernetes")

        # Check package.json for tools
        package_json = self._read_package_json()
        if package_json:
            scripts = package_json.get("scripts", {})
            if "docker" in str(scripts).lower():
                tools.append("docker")

        return sorted(set(tools))

    def _detect_package_manager(self) -> str:
        """Detect package manager (npm, pip, etc.)."""
        if self._check_file_exists("package-lock.json"):
            return "npm"
        if self._check_file_exists("pnpm-lock.yaml"):
            return "pnpm"
        if self._check_file_exists("yarn.lock"):
            return "yarn"
        if self._check_file_exists("requirements.txt"):
            return "pip"
        if self._check_file_exists("pyproject.toml"):
            return "poetry"
        if self._check_file_exists("Gemfile.lock"):
            return "bundler"
        if self._check_file_exists("go.sum"):
            return "go"
        if self._check_file_exists("Cargo.lock"):
            return "cargo"

        return "unknown"

    # Helper methods
    def _check_file_exists(self, path: str) -> bool:
        """Check if file or directory exists in project."""
        full_path = self.project_dir / path
        return full_path.exists()

    def _check_python_version_file(self, pattern: str) -> bool:
        """Check for Python version markers."""
        for py_file in self._project_files():
            if py_file.suffix != ".py":
                continue
            try:
                with open(py_file, encoding="utf-8", errors="replace") as f:
                    head = f.read(100)
            except OSError:
                continue
            if pattern in head:
                return True
        return False

    def _project_files(self) -> Iterator[Path]:
        """Every file of the project, outside dependencies and build output."""
        for root, dirs, files in os.walk(self.project_dir):
            dirs[:] = [d for d in dirs if d not in _SKIPPED_DIRS]
            for name in files:
                yield Path(root, name)

    def _read_package_json(self) -> dict | None:
        """Read package.json."""
        if "package_json" in self.cache:
            return self.cache["package_json"]

        path = self.project_dir / "package.json"
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                self.cache["package_json"] = data
                return data
            except (json.JSONDecodeError, OSError):
                pass
        return None

    def _read_requirements_txt(self) -> str:
        """Read requirements.txt."""
        if "requirements" in self.cache:
            return self.cache["requirements"]

        path = self.project_dir / "requirements.txt"
        content = ""
        if path.is_file():
            content = path.read_text(encoding="utf-8", errors="replace")
        self.cache["requirements"] = content
        return content

    def _python_requirements_text(self) -> str:
        """requirements.txt, plus the dependencies pyproject.toml declares.

        A project that only has a pyproject.toml (Poetry, uv, PDM) named its
        framework nowhere the analyzer read, so a Django or Flask project
        came out as plain "python" and no migration pair matched.
        """
        parts = [self._read_requirements_txt()]
        pyproject = self._read_pyproject_toml() or {}
        project = pyproject.get("project", {})
        parts.extend(project.get("dependencies", []))
        for extra in project.get("optional-dependencies", {}).values():
            parts.extend(extra)
        poetry = pyproject.get("tool", {}).get("poetry", {})
        parts.extend(poetry.get("dependencies", {}))
        return "\n".join(str(part) for part in parts)

    def _read_pyproject_toml(self) -> dict | None:
        """Read pyproject.toml."""
        path = self.project_dir / "pyproject.toml"
        if not path.is_file():
            return None
        try:
            return tomllib.loads(path.read_text(encoding="utf-8", errors="replace"))
        except tomllib.TOMLDecodeError:
            return None

    def _read_tsconfig(self) -> dict | None:
        """Read tsconfig.json."""
        path = self.project_dir / "tsconfig.json"
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        return None

    def _parse_version_spec(self, spec: str) -> str:
        """Parse version specification (e.g., '>=3.8')."""
        match = re.search(r"(\d+\.\d+)", spec)
        return match.group(1) if match else "unknown"

    def _extract_version_from_requirement(self, req: str) -> str:
        """Extract version from requirement line."""
        match = re.search(r"(?:==|>=|<=|>|<|~=)([0-9.]+)", req)
        return match.group(1) if match else "unknown"
