"""CI and test discovery, and the blast radius of a change, read from small
projects on disk (analysis/ci_discovery.py, test_discovery.py, blast_radius.py)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from analysis import ci_discovery
from analysis.blast_radius import analyze_blast_radius
from analysis.ci_discovery import CIDiscovery
from analysis.test_discovery import TestDiscovery


def _write(root: Path, files: dict[str, str]) -> Path:
    for name, content in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return root


# --------------------------------------------------------------------------
# CI discovery
# --------------------------------------------------------------------------


_CI_YML = """name: CI
on:
  push:
  pull_request:
env:
  NODE_ENV: test
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - name: Unit
        run: pytest -q
      - run: pytest tests/slow --cov=app
      - run: npx playwright test
      - "not a mapping"
  notes: just a string
"""


def test_github_actions_triggers_jobs_and_commands(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            ".github/workflows/z.yaml": "on: [push, workflow_dispatch]\njobs:\n  build:\n    steps:\n      - run: dotnet test\n",
            ".github/workflows/ci.yml": _CI_YML,
            ".github/workflows/release.yml": "name: R\non: release\njobs: {}\n",
            ".github/workflows/broken.yml": "jobs: [unclosed\n",
            ".github/workflows/odd.yml": "on: push\njobs: not-a-mapping\n",
        },
    )

    result = CIDiscovery().discover(tmp_path)

    assert result.ci_system == "github_actions"
    # Sorted: the order glob() returned changed from one machine to another.
    assert result.config_files == [
        ".github/workflows/broken.yml",
        ".github/workflows/ci.yml",
        ".github/workflows/odd.yml",
        ".github/workflows/release.yml",
        ".github/workflows/z.yaml",
    ]
    workflows = {w.name: w for w in result.workflows}
    # Regression: YAML 1.1 reads `on` as True, so no trigger was ever found.
    assert workflows["CI/test"].trigger == ["push", "pull_request"]
    assert workflows["z/build"].trigger == ["push", "workflow_dispatch"]
    assert workflows["CI/test"].test_related is True
    assert workflows["CI/test"].steps[0] == "uses: actions/checkout@v4"
    # Regression: each pytest line replaced the unit command; the first stays.
    assert result.test_commands["unit"] == "pytest -q"
    assert result.coverage_command == "pytest tests/slow --cov=app"
    assert result.test_commands["e2e"] == "npx playwright test"
    assert result.environment_variables == ["NODE_ENV"]


@pytest.mark.parametrize(
    "command",
    [
        "dotnet test --no-build",
        "./gradlew test",
        "mvn verify",
        "bundle exec rspec",
        "vendor/bin/phpunit",
        "swift test",
        "flutter test",
        "mix test",
        "go test ./...",
        "cargo test",
    ],
)
def test_the_test_runner_of_every_stack_is_read(tmp_path: Path, command: str) -> None:
    _write(tmp_path, {".gitlab-ci.yml": f"test:\n  script: {command}\n"})

    assert ci_discovery.get_ci_test_commands(tmp_path) == {"unit": command}


def test_gitlab_jobs_skip_keywords_and_templates(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            ".gitlab-ci.yml": (
                "stages: [test]\nvariables:\n  PIP_CACHE: x\n.template:\n  script: [echo]\n"
                "unit:\n  only: [main]\n  script:\n    - npm test\n    - 42\n"
                "integration:\n  script: pytest tests/integration\n"
                "lint: ruff\n"
            )
        },
    )

    result = CIDiscovery().discover(tmp_path)

    assert [w.name for w in result.workflows] == ["unit", "integration"]
    assert result.workflows[0].trigger == ["main"]
    assert result.test_commands == {
        "unit": "npm test",
        "integration": "pytest tests/integration",
    }
    assert result.environment_variables == ["PIP_CACHE"]


def test_circleci_steps(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            ".circleci/config.yml": (
                "jobs:\n  build:\n    steps:\n      - checkout\n      - run: yarn test --coverage\n"
                "      - run:\n          command: npx jest --coverage\n  junk: 1\n"
            )
        },
    )

    result = CIDiscovery().discover(tmp_path)

    assert result.ci_system == "circleci"
    assert result.workflows[0].steps == [
        "checkout",
        "yarn test --coverage",
        "npx jest --coverage",
    ]
    assert result.workflows[0].test_related is True
    assert result.test_commands == {"unit": "yarn test --coverage"}
    assert result.coverage_command == "npx jest --coverage"


def test_jenkinsfile_stages(tmp_path: Path) -> None:
    _write(
        tmp_path,
        {
            "Jenkinsfile": (
                "stage('Build') { sh 'make' }\nstage('Test') { sh \"cargo test\" }\n"
            )
        },
    )

    result = CIDiscovery().discover(tmp_path)

    assert [(w.name, w.test_related, w.steps) for w in result.workflows] == [
        ("Build", False, []),
        ("Test", True, ["make", "cargo test"]),
    ]
    assert ci_discovery.get_ci_system(tmp_path) == "jenkins"


@pytest.mark.parametrize(
    "files",
    [
        {".gitlab-ci.yml": ": : :\n"},
        {".gitlab-ci.yml": ""},
        {".circleci/config.yml": ""},
        {".circleci/config.yml": "jobs: [1]\n"},
    ],
    ids=["gitlab unparsable", "gitlab empty", "circleci empty", "circleci jobs list"],
)
def test_unreadable_configs_give_an_empty_result(
    tmp_path: Path, files: dict[str, str]
) -> None:
    _write(tmp_path, files)

    result = CIDiscovery().discover(tmp_path)

    assert result is not None
    assert result.workflows == [] and result.test_commands == {}


def test_a_jenkinsfile_that_is_not_text_is_skipped(tmp_path: Path) -> None:
    (tmp_path / "Jenkinsfile").write_bytes(b"\xff\xfe\x00")

    assert CIDiscovery().discover(tmp_path).workflows == []


def test_no_ci_and_the_cache(tmp_path: Path) -> None:
    discovery = CIDiscovery()

    assert discovery.discover(tmp_path) is None
    assert ci_discovery.discover_ci(tmp_path / "nowhere") is None
    assert ci_discovery.get_ci_test_commands(tmp_path / "nowhere") == {}
    assert ci_discovery.get_ci_system(tmp_path / "nowhere") is None

    _write(tmp_path, {"Jenkinsfile": "stage('x') {}\n"})
    assert discovery.discover(tmp_path) is None  # cached
    discovery.clear_cache()
    assert discovery.discover(tmp_path).ci_system == "jenkins"
    assert (
        discovery.to_dict(discovery.discover(tmp_path))["workflows"][0]["name"] == "x"
    )


def test_without_pyyaml_no_yaml_config_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(sys.modules, "yaml", None)
    spec = importlib.util.spec_from_file_location("_ci_no_yaml", ci_discovery.__file__)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, "_ci_no_yaml", module)
    spec.loader.exec_module(module)
    _write(tmp_path, {".gitlab-ci.yml": "test:\n  script: pytest\n"})

    assert module.HAS_YAML is False
    assert module.CIDiscovery().discover(tmp_path).workflows == []


# --------------------------------------------------------------------------
# Test discovery
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("files", "name", "command", "config"),
    [
        (
            {"App.sln": "", "Tests/OrderTests.cs": ""},
            "dotnet_test",
            "dotnet test",
            "App.sln",
        ),
        (
            {"pom.xml": "", "mvnw": "", "src/test/AppTest.java": ""},
            "maven",
            "./mvnw test",
            "pom.xml",
        ),
        ({"pom.xml": ""}, "maven", "mvn test", "pom.xml"),
        (
            {"build.gradle.kts": "", "gradlew": ""},
            "gradle",
            "./gradlew test",
            "build.gradle.kts",
        ),
        ({"build.gradle": ""}, "gradle", "gradle test", "build.gradle"),
        (
            {
                "composer.json": '{"require-dev": {"phpunit/phpunit": "^11"}}',
                "tests/CartTest.php": "",
            },
            "phpunit",
            "vendor/bin/phpunit",
            "composer.json",
        ),
        (
            {"Package.swift": "", "Tests/AppTests.swift": ""},
            "swift_test",
            "swift test",
            "Package.swift",
        ),
        (
            {"pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n"},
            "flutter_test",
            "flutter test",
            "pubspec.yaml",
        ),
        (
            {"pubspec.yaml": "name: cli\n", "test/cli_test.dart": ""},
            "dart_test",
            "dart test",
            "pubspec.yaml",
        ),
        ({"mix.exs": "", "test/app_test.exs": ""}, "exunit", "mix test", "mix.exs"),
    ],
    ids=[
        "dotnet",
        "maven wrapper",
        "maven",
        "gradle wrapper",
        "gradle",
        "php",
        "swift",
        "flutter",
        "dart",
        "elixir",
    ],
)
def test_the_runner_of_every_stack(
    tmp_path: Path, files: dict[str, str], name: str, command: str, config: str
) -> None:
    # Regression: a .NET, JVM, PHP, Swift, Dart or Elixir project had no test
    # command, so the QA auto-fix loop could not run its tests.
    result = TestDiscovery().discover(_write(tmp_path, files))

    assert [(f.name, f.command, f.config_file) for f in result.frameworks] == [
        (name, command, config)
    ]
    assert result.test_command == command
    has_test_file = any(
        n.endswith(
            (
                "Tests.cs",
                "Test.java",
                "Test.php",
                "Tests.swift",
                "_test.dart",
                "_test.exs",
            )
        )
        for n in files
    )
    assert result.has_tests is has_test_file


def test_composer_without_phpunit_has_no_runner(tmp_path: Path) -> None:
    _write(tmp_path, {"composer.json": "{}"})

    assert TestDiscovery().discover(tmp_path).frameworks == []


def test_a_dependency_s_tests_are_not_the_project_s(tmp_path: Path) -> None:
    # Regression: the search went into node_modules, so any JavaScript
    # project with dependencies "had tests".
    _write(
        tmp_path,
        {
            "package.json": "{}",
            "node_modules/lib/index.test.js": "",
            "dist/app.spec.js": "",
            "src/app.js": "",
        },
    )

    assert TestDiscovery().discover(tmp_path).has_tests is False


# --------------------------------------------------------------------------
# Blast radius
# --------------------------------------------------------------------------


def test_dependents_tests_flags_and_score(tmp_path: Path) -> None:
    files = {
        "src/a.py": "if FEATURE_NEW_CART:\n    flag('beta.checkout')\n",
        "src/user.py": "from src.a import x\nfrom src.a import y\n",
        "tests/test_a.py": "import src.a\n",
        "web/app.ts": "import React from 'react'\nimport { h } from './happy'\n",
        "node_modules/pkg/index.js": "require('../../src/a')\n",
    }
    files.update({f"src/m{i}.py": "from src import a\n" for i in range(4)})
    _write(tmp_path, files)

    report = analyze_blast_radius(tmp_path, ["src/a.py", "missing.py"])

    sources = sorted(d.source for d in report.dependents)
    # Regression: "a" was looked up as a substring, so 'react' and
    # './happy' made web/app.ts a dependent of src/a.py; and
    # "from src import a" was read as an import of "src" only.
    assert sources == [
        "src/m0.py",
        "src/m1.py",
        "src/m2.py",
        "src/m3.py",
        "src/user.py",
        "tests/test_a.py",
    ]
    assert report.tests == ["tests/test_a.py"]
    assert report.flags == ["FEATURE_NEW_CART", "beta.checkout"]
    assert report.score == "medium"
    assert report.to_dict()["explanation"][-1] == "2 feature flag(s) referenced"
    assert report.targets == ["src/a.py"]


def test_many_dependents_is_high(tmp_path: Path) -> None:
    _write(
        tmp_path, {"core.py": "", **{f"m{i}.py": "import core\n" for i in range(15)}}
    )

    assert analyze_blast_radius(tmp_path, ["core.py"]).score == "high"


def test_targets_outside_the_project_are_ignored(tmp_path: Path) -> None:
    project = _write(tmp_path / "project", {"a.py": ""})
    _write(tmp_path, {"secret.py": "FEATURE_SECRET_THING = 1\n"})

    report = analyze_blast_radius(
        project, ["../secret.py", str(tmp_path / "secret.py")]
    )

    assert report.targets == []
    assert report.explanation == ["no valid target files"]


def test_a_project_root_that_is_not_resolved(tmp_path: Path) -> None:
    real = _write(tmp_path / "real", {"a.py": "", "b.py": "import a\n"})
    (tmp_path / "other").mkdir()

    # Regression: the target was resolved and the root was not, so
    # relative_to() raised for "<tmp>/other/../real".
    report = analyze_blast_radius(tmp_path / "other" / ".." / "real", ["a.py"])

    assert [d.source for d in report.dependents] == ["b.py"]
    assert real.is_dir()
