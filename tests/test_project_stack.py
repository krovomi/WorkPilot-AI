"""The project stack facade answers what each detector answered before it.

Lot L11 (audit F26) moved four detectors behind `project/stack.py` and pointed
their callers at it. The answers are pinned here on fixture projects, captured
from the detectors before the move (`fixtures/project_stack/golden.json`): a
facade that changed a single verdict would change a roster, a validation
strategy or an API test draft somewhere downstream.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from project import stack  # noqa: E402

GOLDEN = json.loads(
    (Path(__file__).parent / "fixtures" / "project_stack" / "golden.json").read_text(
        encoding="utf-8"
    )
)

FIXTURES: dict[str, dict[str, str]] = {
    "react-vite": {
        "package.json": '{"name":"x","scripts":{"test":"vitest run","build":"vite build"},"dependencies":{"react":"18","react-dom":"18"},"devDependencies":{"vitest":"1","typescript":"5"}}',
        "tsconfig.json": "{}",
        "src/App.tsx": "export const App = () => null;\n",
        "pnpm-lock.yaml": "",
    },
    "nextjs": {
        "package.json": '{"name":"x","dependencies":{"next":"14","react":"18"},"devDependencies":{"jest":"29","@playwright/test":"1"}}',
        "next.config.js": "module.exports = {}\n",
        "yarn.lock": "",
    },
    "express-api": {
        "package.json": '{"name":"x","dependencies":{"express":"4"},"scripts":{"test":"jest"}}',
        "src/server.js": "const app = require('express')();\napp.get('/api/orders', h);\n",
    },
    "fastapi": {
        "pyproject.toml": '[project]\nname="x"\ndependencies=["fastapi","uvicorn"]\n',
        "app/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
        "Dockerfile": "FROM python:3.12\n",
    },
    "python-cli": {
        "pyproject.toml": '[project]\nname="x"\ndependencies=["click"]\n[project.scripts]\nx="x:main"\n',
        "x/__init__.py": "",
    },
    "django-req": {
        "requirements.txt": "Django==5.0\n",
        "manage.py": "",
    },
    "dotnet-api": {
        "Shop.sln": "Microsoft Visual Studio Solution File\n",
        "src/Shop.Api/Shop.Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
        "src/Shop.Api/Program.cs": 'var app = WebApplication.CreateBuilder(args).Build();\napp.MapGet("/orders", () => 1);\n',
        "tests/Shop.Tests/Shop.Tests.csproj": '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" Version="2.6.0" /></ItemGroup></Project>\n',
    },
    "wpf": {
        "App.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWPF>true</UseWPF><TargetFramework>net8.0-windows</TargetFramework></PropertyGroup></Project>\n',
        "MainWindow.xaml": "<Window/>\n",
    },
    "spring": {
        "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>\n",
        "src/main/java/App.java": "class App {}\n",
    },
    "go-api": {
        "go.mod": "module x\n\ngo 1.22\n",
        "main.go": "package main\n",
        ".github/workflows/ci.yml": "on: push\n",
    },
    "rust": {
        "Cargo.toml": '[package]\nname="x"\nversion="0.1.0"\n',
        "src/main.rs": "fn main(){}\n",
        ".gitlab-ci.yml": "x: 1\n",
    },
    "flutter": {
        "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
        "lib/main.dart": "void main(){}\n",
        "android/app/src/main/AndroidManifest.xml": "<manifest/>\n",
        "ios/Runner/Info.plist": "<plist/>\n",
    },
    "android-native": {
        "settings.gradle.kts": 'rootProject.name = "x"\n',
        "build.gradle.kts": "plugins {}\n",
        "app/build.gradle.kts": 'plugins { id("com.android.application") }\n',
        "app/src/main/AndroidManifest.xml": "<manifest/>\n",
        "app/src/main/java/x/Main.kt": "class Main\n",
    },
    "electron": {
        "package.json": '{"name":"x","devDependencies":{"electron":"30"},"dependencies":{"react":"18"}}',
    },
    "static-html": {
        "index.html": "<html></html>\n",
        "style.css": "body{}\n",
    },
    "ruby": {
        "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
    },
    "empty": {},
}


def _materialise(root: Path, name: str) -> Path:
    base = root / name
    base.mkdir(parents=True, exist_ok=True)
    for rel, text in FIXTURES[name].items():
        path = base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return base


def test_every_fixture_has_a_golden_answer():
    assert set(FIXTURES) == set(GOLDEN)


@pytest.mark.parametrize("name", sorted(FIXTURES))
def test_the_facade_answers_as_the_detectors_did(tmp_path, name):
    from runners.flaky_tests_runner import _detect_languages as report_languages

    project = _materialise(tmp_path, name)
    expected = GOLDEN[name]
    manifest = stack.detect_project_stack(project)
    ui = stack.ui_stack(project)
    mobile = stack.mobile_stack(project)
    got = {
        "manifest": {
            k: (sorted(v) if isinstance(v, list) else v) for k, v in manifest.items()
        },
        "languages": sorted(stack.detect_languages(project)),
        "api": list(stack.detect_api_stack(project)),
        "project_type": stack.detect_project_type(project),
        "report": [list(x) for x in report_languages(project)],
        "tech_languages": stack.technology_stack(project).languages,
        "frameworks": stack.frameworks(project),
        "ui": [[t.name, t.guide, t.root] for t in ui.toolkits],
        "mobile": [mobile.framework, list(mobile.platforms)] if mobile else None,
    }
    assert got == expected


def test_the_old_import_paths_still_answer():
    """Re-exported while callers migrate: the same function, not a copy."""
    from agents.subagents import detect_languages
    from docintel.api_tests import detect_api_stack
    from runners.pipeline_generator_runner import detect_project_stack
    from spec.validation_strategy import detect_project_type

    assert detect_languages is stack.detect_languages
    assert detect_api_stack is stack.detect_api_stack
    assert detect_project_stack is stack.detect_project_stack
    assert detect_project_type is stack.detect_project_type


def test_marker_rules_keep_their_order_and_skip_ignored_dirs(tmp_path):
    (tmp_path / "node_modules" / "x").mkdir(parents=True)
    (tmp_path / "node_modules" / "x" / "go.mod").write_text("", encoding="utf-8")
    (tmp_path / "App.csproj").write_text("", encoding="utf-8")
    (tmp_path / "Cargo.toml").write_text("", encoding="utf-8")
    rules = [("rust", ("Cargo.toml",)), ("go", ("go.mod",)), ("dotnet", ("*.csproj",))]
    assert stack.detect_markers(tmp_path, rules, ignores={"node_modules"}) == [
        "rust",
        "dotnet",
    ]
