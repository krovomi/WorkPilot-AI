"""The edges of test discovery and of the project index: lockfiles, npm
scripts, fallbacks, unreadable files, monorepo markers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from analysis.analyzers.project_analyzer_module import ProjectAnalyzer
from analysis.analyzers.route_detector import RouteDetector
from analysis.test_discovery import TestDiscovery


def _write(root: Path, files: dict[str, str]) -> Path:
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return root


@pytest.mark.parametrize(
    ("lockfile", "manager"),
    [
        ("bun.lock", "bun"),
        ("uv.lock", "uv"),
        ("poetry.lock", "poetry"),
        ("Pipfile.lock", "pipenv"),
        ("Cargo.lock", "cargo"),
        ("go.sum", "go"),
        ("Gemfile.lock", "bundler"),
        ("README.md", ""),
    ],
)
def test_the_package_manager_comes_from_the_lockfile(
    tmp_path: Path, lockfile: str, manager: str
) -> None:
    _write(tmp_path, {lockfile: ""})

    assert TestDiscovery().discover(tmp_path).package_manager == manager


@pytest.mark.parametrize(
    ("script", "name", "kind"),
    [
        ("jest --ci", "jest", "unit"),
        ("vitest run", "vitest", "unit"),
        ("mocha", "mocha", "unit"),
        ("playwright test", "playwright", "e2e"),
        ("cypress run", "cypress", "e2e"),
        ("node run-tests.js", "npm_test", "unit"),
    ],
)
def test_the_npm_test_script_names_the_framework(
    tmp_path: Path, script: str, name: str, kind: str
) -> None:
    _write(
        tmp_path,
        {
            "package.json": json.dumps({"scripts": {"test": script}}),
            "pnpm-lock.yaml": "",
        },
    )

    framework = TestDiscovery().discover(tmp_path).frameworks[0]

    assert (framework.name, framework.type) == (name, kind)


def test_npm_s_placeholder_test_script_is_no_framework(tmp_path: Path) -> None:
    placeholder = 'echo "Error: no test specified" && exit 1'
    _write(tmp_path, {"package.json": json.dumps({"scripts": {"test": placeholder}})})

    assert TestDiscovery().discover(tmp_path).frameworks == []


def test_unittest_is_the_python_fallback(tmp_path: Path) -> None:
    _write(tmp_path, {"setup.py": "", "test_unit/test_x.py": ""})

    result = TestDiscovery().discover(tmp_path)

    assert [(f.name, f.command) for f in result.frameworks] == [
        ("unittest", "python -m unittest discover")
    ]
    assert result.test_directories == ["test_unit"]
    assert result.has_tests is True


def test_ruby_minitest_and_an_undecodable_gemfile(tmp_path: Path) -> None:
    _write(tmp_path, {"Gemfile": "gem 'minitest'\n"})
    assert TestDiscovery().discover(tmp_path).test_command == "bundle exec rake test"

    other = tmp_path / "other"
    other.mkdir()
    # Regression: a Gemfile that is not UTF-8 raised UnicodeDecodeError out of
    # discover(), which the QA auto-fix loop calls in its constructor.
    (other / "Gemfile").write_bytes(b"gem 'rspec' # \xe9t\xe9\n")
    assert TestDiscovery().discover(other).test_command == "bundle exec rspec"


def test_an_apps_folder_makes_a_monorepo(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            "apps/web/package.json": json.dumps({"dependencies": {"react": "18"}}),
            "apps/.cache/package.json": "{}",
        },
    )

    index = ProjectAnalyzer(tmp_path).analyze()

    assert index["project_type"] == "monorepo"
    assert set(index["services"]) == {"web"}


def test_ruff_and_black_from_pyproject(tmp_path: Path) -> None:
    _write(tmp_path, {"pyproject.toml": "[tool.ruff]\n[tool.black]\n"})

    conventions = ProjectAnalyzer(tmp_path).analyze()["conventions"]

    assert conventions["python_linting"] == "Ruff"
    assert conventions["python_formatting"] == "Black"


def test_an_undecodable_pyproject_reads_as_empty(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_bytes(b"\xff\xfe[tool.ruff]")

    assert "python_linting" not in ProjectAnalyzer(tmp_path).analyze()["conventions"]


def test_undecodable_route_files_are_skipped(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            "routes/web.php": "Route::get('/ok', h);\n",
            "src/ok.controller.ts": "@Controller('a')\nclass A { @Get() x() {} }\n",
        },
    )
    (tmp_path / "routes" / "api.php").write_bytes(b"\xff\xfeRoute::get('/x', h);")
    (tmp_path / "src" / "bad.controller.ts").write_bytes(b"\xff\xfe@Controller('b')")
    (tmp_path / "app" / "api" / "x").mkdir(parents=True)
    (tmp_path / "app" / "api" / "x" / "route.ts").write_bytes(
        b"\xff\xfeexport function GET"
    )

    paths = sorted(r["path"] for r in RouteDetector(tmp_path).detect_all_routes())

    assert paths == ["/a", "/ok"]
