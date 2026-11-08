"""The task form's "Mobile platforms" box: the app a project has, or how to add one.

On a .NET Web API the Android / iOS boxes meant nothing: there was no app to
build. ``mobile.bootstrap.mobile_profile`` says whether the project has a
phone app, and when it has none which framework fits the stacks already in
the repository, so the form can create the setup tasks.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from mobile.bootstrap import (  # noqa: E402
    FRAMEWORKS,
    host_stacks,
    mobile_dir_for,
    mobile_profile,
    rank_frameworks,
)
from mobile.stacks import detect_stack  # noqa: E402


def _write(path: Path, text: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _package(path: Path, deps: dict[str, str]) -> None:
    _write(path / "package.json", json.dumps({"name": "x", "dependencies": deps}))


def _first(profile: dict) -> str:
    return profile["frameworks"][0]["id"]


def test_a_project_with_an_app_keeps_its_framework(tmp_path):
    _write(
        tmp_path / "pubspec.yaml",
        "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n",
    )
    _write(tmp_path / "android" / "app" / "build.gradle")
    _write(tmp_path / "ios" / "Runner.xcodeproj" / "project.pbxproj")

    profile = mobile_profile(tmp_path)

    assert profile["isMobile"] is True
    assert profile["stack"]["framework"] == "flutter"
    assert "frameworks" not in profile


def test_a_dotnet_web_api_is_offered_maui(tmp_path):
    _write(tmp_path / "Shop.sln")
    _write(
        tmp_path / "src" / "Shop.Api" / "Shop.Api.csproj",
        '<Project Sdk="Microsoft.NET.Sdk.Web" />',
    )

    profile = mobile_profile(tmp_path)

    assert profile["isMobile"] is False
    assert "dotnet" in profile["hostStacks"]
    assert _first(profile) == "dotnet-maui"
    maui = profile["frameworks"][0]
    assert "dotnet workload install maui" in maui["install"]
    assert any(
        "dotnet new maui" in line and "mobile" in line for line in maui["scaffold"]
    )


@pytest.mark.parametrize(
    ("deps", "expected"),
    [
        ({"react": "19"}, "expo"),
        ({"next": "16"}, "expo"),
        ({"@angular/core": "21"}, "capacitor"),
        ({"vue": "3"}, "capacitor"),
        ({"nuxt": "4"}, "capacitor"),
        ({"express": "5"}, "expo"),
    ],
)
def test_a_web_front_end_is_offered_the_framework_of_its_language(
    tmp_path, deps, expected
):
    _package(tmp_path / "apps" / "web", deps)
    assert _first(mobile_profile(tmp_path)) == expected


@pytest.mark.parametrize(
    ("manifest", "stack", "expected"),
    [
        ("go.mod", "go", "flutter"),
        ("Cargo.toml", "rust", "flutter"),
        ("pyproject.toml", "python", "flutter"),
        ("composer.json", "php", "flutter"),
        ("Gemfile", "ruby", "flutter"),
        ("mix.exs", "elixir", "flutter"),
        ("build.gradle.kts", "jvm", "kotlin-multiplatform"),
        ("pom.xml", "jvm", "kotlin-multiplatform"),
        ("Package.swift", "swift", "ios-native"),
    ],
)
def test_every_backend_stack_gets_a_proposal(tmp_path, manifest, stack, expected):
    _write(tmp_path / "server" / manifest)
    profile = mobile_profile(tmp_path)
    assert stack in profile["hostStacks"]
    assert _first(profile) == expected


def test_every_framework_is_always_offered_once():
    for stacks in ([], ["dotnet"], ["react", "python"], ["swift"]):
        ranked = rank_frameworks(stacks)
        assert sorted(ranked) == sorted(FRAMEWORKS)


def test_an_empty_folder_gets_a_neutral_default(tmp_path):
    profile = mobile_profile(tmp_path)
    assert profile["hostStacks"] == []
    assert _first(profile) == "flutter"


def test_single_platform_frameworks_say_so():
    assert FRAMEWORKS["android-native"].platforms == ("android",)
    assert FRAMEWORKS["ios-native"].platforms == ("ios",)
    for framework in FRAMEWORKS.values():
        assert set(framework.platform_setup) == set(framework.platforms)


def test_build_output_and_dependencies_are_not_read(tmp_path):
    _package(tmp_path / "node_modules" / "react", {"react": "19"})
    _write(tmp_path / "bin" / "Debug" / "Leftover.csproj")
    assert host_stacks(tmp_path) == []


def test_the_new_app_goes_next_to_the_other_apps(tmp_path):
    assert mobile_dir_for(tmp_path) == "mobile"
    (tmp_path / "apps").mkdir()
    assert mobile_dir_for(tmp_path) == "apps/mobile"
    (tmp_path / "apps" / "mobile").mkdir()
    assert mobile_dir_for(tmp_path) == "apps/mobile-app"


def test_names_suit_every_framework(tmp_path):
    project = tmp_path / "42-shop-api"
    project.mkdir()
    profile = mobile_profile(project)
    assert profile["appName"] == "App42ShopApiMobile"
    flutter = next(f for f in profile["frameworks"] if f["id"] == "flutter")
    # Dart package names are lower_snake_case.
    assert "--project-name app42_shop_api_mobile" in flutter["scaffold"][0]


def test_a_monorepo_app_is_found_whatever_sorts_after_it(tmp_path):
    """The walker expanded only the last directory of each level: `apps/mobile`
    was missed as soon as a `tests/` folder sorted after `apps/`."""
    _package(tmp_path / "apps" / "mobile", {"expo": "54", "react-native": "0.81"})
    (tmp_path / "apps" / "mobile" / "app.json").write_text("{}", encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "tests").mkdir()

    stack = detect_stack(tmp_path)

    assert stack is not None
    assert Path(stack.project_dir).name == "mobile"
    assert mobile_profile(tmp_path)["isMobile"] is True


def test_the_runner_answers_the_profile(tmp_path):
    _write(tmp_path / "go.mod", "module x\n")
    result = subprocess.run(
        [
            sys.executable,
            str(_BACKEND / "runners" / "mobile_runner.py"),
            "--project-dir",
            str(tmp_path),
            "--action",
            "profile",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(_BACKEND),
        timeout=60,
        check=False,
    )
    line = next(
        row
        for row in result.stdout.splitlines()
        if row.startswith("__MOBILE_RESULT__:")
    )
    payload = json.loads(line.split(":", 1)[1])
    assert payload["isMobile"] is False
    assert payload["frameworks"][0]["id"] == "flutter"
