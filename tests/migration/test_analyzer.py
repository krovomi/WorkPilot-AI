"""The stack the Code Migration page starts from, read from real project files.

`StackAnalyzer.detect_stack` names the source framework the planner pairs
with the target: every case below is a small project on disk.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from migration.analyzer import StackAnalyzer


def _write(root: Path, rel: str, text: str = "") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _package(root: Path, **sections: dict) -> None:
    _write(root, "package.json", json.dumps({"name": "app", **sections}))


def _stack(root: Path):
    return StackAnalyzer(str(root)).detect_stack()


class TestFramework:
    @pytest.mark.parametrize(
        ("installed", "framework"),
        [
            ("node_modules/react", "react"),
            ("node_modules/vue", "vue"),
            ("node_modules/@angular/core", "angular"),
            ("node_modules/svelte", "svelte"),
        ],
    )
    def test_an_installed_package_names_it(self, tmp_path, installed, framework):
        (tmp_path / installed).mkdir(parents=True)

        assert _stack(tmp_path).framework == framework

    @pytest.mark.parametrize(
        ("deps", "dev", "framework"),
        [
            ({"react": "18.2.0"}, {}, "react"),
            ({}, {"vue": "^3.4"}, "vue"),
            ({"@angular/core": "17"}, {}, "angular"),
            ({"svelte": "4"}, {}, "svelte"),
            ({"express": "4"}, {}, "express"),
            ({"fastify": "4"}, {}, "fastify"),
            ({"koa": "2"}, {}, "koa"),
            ({"lodash": "4"}, {}, "nodejs"),
        ],
    )
    def test_package_json_names_it(self, tmp_path, deps, dev, framework):
        _package(tmp_path, dependencies=deps, devDependencies=dev)

        assert _stack(tmp_path).framework == framework

    @pytest.mark.parametrize(
        ("requirements", "framework"),
        [
            ("Django==5.0\n", "django"),
            ("flask>=3\n", "flask"),
            ("fastapi\nuvicorn\n", "fastapi"),
            ("requests\n", "python"),
        ],
    )
    def test_requirements_txt_names_it(self, tmp_path, requirements, framework):
        _write(tmp_path, "requirements.txt", requirements)

        assert _stack(tmp_path).framework == framework

    @pytest.mark.parametrize(
        ("pyproject", "framework"),
        [
            ('[project]\nname = "a"\ndependencies = ["django>=5"]\n', "django"),
            (
                '[project]\nname = "a"\n[project.optional-dependencies]\n'
                'web = ["flask"]\n',
                "flask",
            ),
            (
                '[tool.poetry.dependencies]\npython = "^3.12"\nfastapi = "*"\n',
                "fastapi",
            ),
            ("not = [valid toml", "python"),
        ],
    )
    def test_a_pyproject_only_project_names_it(self, tmp_path, pyproject, framework):
        # Regression: only requirements.txt was read, so a Poetry or uv
        # project came out as plain "python" and no migration pair matched.
        _write(tmp_path, "pyproject.toml", pyproject)

        assert _stack(tmp_path).framework == framework

    def test_an_empty_project_is_unknown(self, tmp_path):
        stack = _stack(tmp_path)

        assert (stack.framework, stack.language, stack.version) == (
            "unknown",
            "unknown",
            "unknown",
        )


class TestLanguage:
    @pytest.mark.parametrize(
        ("marker", "language"),
        [
            ("tsconfig.json", "typescript"),
            ("setup.py", "python"),
            ("pyproject.toml", "python"),
            ("pom.xml", "java"),
            ("build.gradle", "java"),
            ("go.mod", "go"),
            ("Cargo.toml", "rust"),
        ],
    )
    def test_a_marker_file_names_it(self, tmp_path, marker, language):
        _write(tmp_path, marker, "{}" if marker.endswith(".json") else "")

        assert _stack(tmp_path).language == language

    @pytest.mark.parametrize(
        ("files", "language"),
        [
            (["a.py", "b.py", "c.js"], "python"),
            (["a.js", "b.jsx", "c.py"], "javascript"),
            (["a.ts", "b.tsx", "c.js"], "typescript"),
            (["A.java"], "java"),
            (["main.go"], "go"),
            (["lib.rs"], "rust"),
        ],
    )
    def test_the_most_common_source_file_names_it(self, tmp_path, files, language):
        for name in files:
            _write(tmp_path, f"src/{name}")

        assert _stack(tmp_path).language == language

    def test_dependencies_and_build_output_are_not_the_project(self, tmp_path):
        # Regression: rglob walked node_modules, .venv and the task worktrees,
        # so a Python project with a frontend toolchain came out as JavaScript.
        _write(tmp_path, "app/main.py")
        for skipped in (
            "node_modules/x",
            ".venv/lib",
            ".workpilot/worktrees/t",
            "dist",
        ):
            for i in range(3):
                _write(tmp_path, f"{skipped}/f{i}.js")

        assert _stack(tmp_path).language == "python"


class TestVersion:
    def test_a_python2_shebang_is_python_2(self, tmp_path):
        _write(tmp_path, "setup.py", "#!/usr/bin/env python2\nimport os\n")

        assert _stack(tmp_path).version == "2.7"

    def test_requires_python_gives_the_version(self, tmp_path):
        _write(tmp_path, "pyproject.toml", '[project]\nrequires-python = ">=3.11"\n')

        assert _stack(tmp_path).version == "3.11"

    def test_an_unparsable_requires_python_is_unknown(self, tmp_path):
        _write(tmp_path, "pyproject.toml", '[project]\nrequires-python = "latest"\n')

        assert _stack(tmp_path).version == "unknown"

    def test_python_without_a_declared_version_defaults(self, tmp_path):
        _write(tmp_path, "setup.py", "from setuptools import setup\n")

        assert _stack(tmp_path).version == "3.8"

    def test_an_unreadable_python_file_is_skipped(self, tmp_path, monkeypatch):
        _write(tmp_path, "setup.py", "import os\n")
        locked = _write(tmp_path, "locked.py", "#!/usr/bin/env python2\n")

        def guarded_open(path, encoding="utf-8", errors=None):
            if Path(path) == locked:
                raise PermissionError(13, "Permission denied", str(path))
            return open(path, encoding=encoding, errors=errors)

        # The module's own `open` name: the analyzer reads through it.
        monkeypatch.setattr("migration.analyzer.open", guarded_open, raising=False)

        assert _stack(tmp_path).version == "3.8"

    def test_a_tsconfig_target_is_the_version(self, tmp_path):
        _write(tmp_path, "tsconfig.json", '{"compilerOptions": {"target": "es2022"}}')

        assert _stack(tmp_path).version == "es2022"

    def test_a_tsconfig_without_target_defaults(self, tmp_path):
        _write(tmp_path, "tsconfig.json", "{}")

        assert _stack(tmp_path).version == "es2020"

    def test_an_invalid_tsconfig_falls_back_to_package_json(self, tmp_path):
        _write(tmp_path, "tsconfig.json", "{ // comments are not JSON")
        _package(tmp_path, devDependencies={"typescript": "5.4.0"})

        assert _stack(tmp_path).version == "5.4.0"

    def test_react_and_vue_versions_come_from_package_json(self, tmp_path):
        _package(tmp_path, dependencies={"react": "18.2.0"})
        assert _stack(tmp_path).version == "18.2.0"

        other = tmp_path / "other"
        _package(other, dependencies={"vue": "3.4.0"})
        assert _stack(other).version == "3.4.0"

    def test_a_node_project_without_a_known_framework_is_unknown(self, tmp_path):
        _package(tmp_path, dependencies={"express": "4"})

        assert _stack(tmp_path).version == "unknown"


class TestDatabase:
    @pytest.mark.parametrize(
        ("deps", "database", "version"),
        [
            ({"mysql2": "3.9"}, "mysql", "3.9"),
            ({"pg": "8.11"}, "postgresql", "8.11"),
            ({"mongodb": "6"}, "mongodb", None),
            ({"redis": "4"}, "redis", None),
        ],
    )
    def test_a_node_driver_names_it(self, tmp_path, deps, database, version):
        _package(tmp_path, dependencies=deps)

        stack = _stack(tmp_path)

        assert (stack.database, stack.db_version) == (database, version)

    @pytest.mark.parametrize(
        ("requirements", "database", "version"),
        [
            ("mysqlclient==2.2\n", "mysql", "2.2"),
            ("psycopg2==2.9\n", "postgresql", None),
            ("postgresql-wheel>=16.0\n", "postgresql", "16.0"),
            ("pymongo\n", "mongodb", None),
            ("redis==5.0\n", "redis", "5.0"),
        ],
    )
    def test_a_python_driver_names_it(self, tmp_path, requirements, database, version):
        _write(tmp_path, "requirements.txt", requirements)

        stack = _stack(tmp_path)

        assert (stack.database, stack.db_version) == (database, version)

    def test_a_pyproject_driver_names_it(self, tmp_path):
        _write(
            tmp_path,
            "pyproject.toml",
            '[project]\ndependencies = ["psycopg[binary]"]\n',
        )

        assert _stack(tmp_path).database == "postgresql"

    def test_an_sqlite_schema_names_it(self, tmp_path):
        _write(tmp_path, "db/schema.sql", "PRAGMA foreign_keys = ON;\n")

        assert _stack(tmp_path).database == "sqlite"

    def test_a_dump_that_is_not_utf8_does_not_stop_the_analysis(self, tmp_path):
        # Regression: read_text(encoding="utf-8") raised on a Latin-1 dump,
        # and the page reported the migration as unsupported.
        (tmp_path / "dump.sql").write_bytes(b"-- caf\xe9\nPRAGMA journal_mode=WAL;\n")

        assert _stack(tmp_path).database == "sqlite"

    def test_other_sql_is_no_database(self, tmp_path):
        _write(tmp_path, "q.sql", "SELECT 1;\n")

        assert _stack(tmp_path).database is None

    def test_a_node_project_without_a_driver_has_no_database_version(self, tmp_path):
        analyzer = StackAnalyzer(str(tmp_path))
        _package(tmp_path, dependencies={"left-pad": "1"})

        assert analyzer._detect_db_version("mysql") is None
        assert analyzer._detect_db_version(None) is None


class TestDependenciesToolsPackageManager:
    def test_dependencies_merge_package_json_and_requirements(self, tmp_path):
        _package(tmp_path, dependencies={"react": "18"}, devDependencies={"vite": "5"})
        _write(tmp_path, "requirements.txt", "# tools\nrequests==2.31\nrich\n\n")

        deps = _stack(tmp_path).dependencies

        assert deps == {
            "react": "18",
            "requests": "2.31",
            "rich": "unknown",
            "vite": "5",
        }

    def test_dependencies_are_capped(self, tmp_path):
        _package(tmp_path, dependencies={f"pkg{i:02}": "1" for i in range(40)})

        assert len(_stack(tmp_path).dependencies) == 30

    def test_tools_are_found_from_their_files(self, tmp_path):
        for name in ("webpack.config.js", "vite.config.js", ".babelrc", "Dockerfile"):
            _write(tmp_path, name)
        (tmp_path / "k8s").mkdir()

        assert _stack(tmp_path).additional_tools == [
            "babel",
            "docker",
            "kubernetes",
            "vite",
            "webpack",
        ]

    def test_babel_config_and_docker_scripts_count(self, tmp_path):
        _write(tmp_path, "babel.config.js")
        _package(tmp_path, scripts={"up": "docker compose up"})

        assert _stack(tmp_path).additional_tools == ["babel", "docker"]

    @pytest.mark.parametrize(
        ("lockfile", "manager"),
        [
            ("package-lock.json", "npm"),
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("requirements.txt", "pip"),
            ("pyproject.toml", "poetry"),
            ("Gemfile.lock", "bundler"),
            ("go.sum", "go"),
            ("Cargo.lock", "cargo"),
            ("README.md", "unknown"),
        ],
    )
    def test_the_lockfile_names_the_package_manager(self, tmp_path, lockfile, manager):
        _write(tmp_path, lockfile)

        assert _stack(tmp_path).package_manager == manager


class TestReading:
    def test_package_json_is_read_once(self, tmp_path):
        _package(tmp_path, dependencies={"react": "18"})
        analyzer = StackAnalyzer(str(tmp_path))

        first = analyzer._read_package_json()
        (tmp_path / "package.json").unlink()

        assert analyzer._read_package_json() is first

    def test_an_invalid_package_json_is_ignored(self, tmp_path):
        _write(tmp_path, "package.json", "{not json")

        assert _stack(tmp_path).framework == "unknown"

    def test_requirements_are_read_once(self, tmp_path):
        _write(tmp_path, "requirements.txt", "flask\n")
        analyzer = StackAnalyzer(str(tmp_path))

        assert analyzer._read_requirements_txt() == "flask\n"
        (tmp_path / "requirements.txt").unlink()
        assert analyzer._read_requirements_txt() == "flask\n"
