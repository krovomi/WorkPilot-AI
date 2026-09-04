"""Detecting a phone application, and refusing to guess when it is not one.

The detector decides which commands an agent will run and which platform rules
it is told about. Getting it wrong is not a degraded experience: a Flutter
project read as a bare Android one hands the coder `./gradlew assembleDebug`
for a tree where the Dart build is the thing that matters.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from mobile.stacks import (  # noqa: E402
    ANDROID,
    IOS,
    detect_stack,
    is_mobile_project,
    normalise_targets,
)


def _android_native(root: Path) -> Path:
    (root / "app" / "src" / "main").mkdir(parents=True)
    (root / "settings.gradle.kts").write_text(
        'plugins { id("com.android.application") }', encoding="utf-8"
    )
    (root / "app" / "build.gradle.kts").write_text(
        'android { defaultConfig { applicationId = "com.acme.app" } }', encoding="utf-8"
    )
    (root / "app" / "src" / "main" / "AndroidManifest.xml").write_text(
        '<manifest package="com.acme.app" />', encoding="utf-8"
    )
    (root / "gradlew").write_text("", encoding="utf-8")
    return root


def _flutter(root: Path) -> Path:
    (root / "android").mkdir(parents=True)
    (root / "ios").mkdir(parents=True)
    (root / "pubspec.yaml").write_text(
        "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n", encoding="utf-8"
    )
    return root


class TestNativeProjects:
    def test_android_gradle_project_is_detected(self, tmp_path):
        stack = detect_stack(_android_native(tmp_path))
        assert stack is not None
        assert stack.framework == "android-native"
        assert stack.platforms == (ANDROID,)

    def test_the_application_id_is_read_from_gradle(self, tmp_path):
        stack = detect_stack(_android_native(tmp_path))
        assert stack.package_id == "com.acme.app"

    def test_the_committed_wrapper_wins_over_a_system_gradle(self, tmp_path):
        stack = detect_stack(_android_native(tmp_path))
        assert stack.commands_for(ANDROID).build.startswith("./gradlew")

    def test_a_project_without_a_wrapper_falls_back_to_gradle(self, tmp_path):
        root = _android_native(tmp_path)
        (root / "gradlew").unlink()
        stack = detect_stack(root)
        assert stack.commands_for(ANDROID).build.startswith("gradle ")

    def test_an_xcode_project_is_detected(self, tmp_path):
        (tmp_path / "Demo.xcodeproj").mkdir()
        stack = detect_stack(tmp_path)
        assert stack is not None
        assert stack.framework == "ios-native"
        assert stack.platforms == (IOS,)

    def test_a_workspace_is_preferred_over_the_bare_project(self, tmp_path):
        (tmp_path / "Demo.xcodeproj").mkdir()
        (tmp_path / "Demo.xcworkspace").mkdir()
        stack = detect_stack(tmp_path)
        # Building the .xcodeproj when CocoaPods is in play omits the Pods
        # target and fails at link time — a failure that reads like a source error.
        assert "-workspace" in stack.commands_for(IOS).build


class TestCrossPlatformProjects:
    def test_flutter_reports_both_platforms(self, tmp_path):
        stack = detect_stack(_flutter(tmp_path))
        assert stack.framework == "flutter"
        assert stack.platforms == (ANDROID, IOS)
        assert stack.is_cross_platform

    def test_flutter_wins_over_the_android_project_it_contains(self, tmp_path):
        """A Flutter tree holds a full Gradle project; the Dart build is the point."""
        root = _flutter(tmp_path)
        (root / "android" / "settings.gradle").write_text(
            'include ":app"', encoding="utf-8"
        )
        assert detect_stack(root).framework == "flutter"

    def test_a_flutter_package_without_platform_folders_is_not_an_app(self, tmp_path):
        (tmp_path / "pubspec.yaml").write_text(
            "name: lib\ndependencies:\n  flutter:\n    sdk: flutter\n", encoding="utf-8"
        )
        assert detect_stack(tmp_path) is None

    def test_expo_is_told_apart_from_bare_react_native(self, tmp_path):
        (tmp_path / "package.json").write_text(
            '{"dependencies": {"expo": "52.0.0", "react-native": "0.76.0"}}',
            encoding="utf-8",
        )
        assert detect_stack(tmp_path).framework == "expo"

    def test_bare_react_native_needs_a_native_folder(self, tmp_path):
        (tmp_path / "package.json").write_text(
            '{"dependencies": {"react-native": "0.76.0"}}', encoding="utf-8"
        )
        assert detect_stack(tmp_path) is None
        (tmp_path / "android").mkdir()
        assert detect_stack(tmp_path).framework == "react-native"

    def test_maui_reads_its_target_frameworks(self, tmp_path):
        (tmp_path / "App.csproj").write_text(
            "<Project><PropertyGroup><UseMaui>true</UseMaui>"
            "<TargetFrameworks>net10.0-android;net10.0-ios</TargetFrameworks>"
            "</PropertyGroup></Project>",
            encoding="utf-8",
        )
        stack = detect_stack(tmp_path)
        assert stack.framework == "dotnet-maui"
        assert stack.platforms == (ANDROID, IOS)
        assert "net10.0-android" in stack.commands_for(ANDROID).build

    def test_a_maui_project_targeting_android_only_says_so(self, tmp_path):
        (tmp_path / "App.csproj").write_text(
            "<Project><PropertyGroup><UseMaui>true</UseMaui>"
            "<TargetFrameworks>net10.0-android</TargetFrameworks>"
            "</PropertyGroup></Project>",
            encoding="utf-8",
        )
        assert detect_stack(tmp_path).platforms == (ANDROID,)


class TestNotMobile:
    def test_a_python_project_is_not_a_mobile_one(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[project]\nname='x'\n", encoding="utf-8"
        )
        assert detect_stack(tmp_path) is None
        assert not is_mobile_project(tmp_path)

    def test_a_missing_directory_is_an_answer_not_an_error(self, tmp_path):
        assert detect_stack(tmp_path / "nope") is None

    def test_none_is_tolerated(self):
        assert detect_stack(None) is None


class TestNestedProjects:
    def test_a_monorepo_app_is_found_below_the_root(self, tmp_path):
        _android_native(tmp_path / "apps" / "mobile")
        stack = detect_stack(tmp_path)
        assert stack is not None
        assert stack.project_dir.endswith(str(Path("apps") / "mobile"))

    def test_node_modules_is_never_walked(self, tmp_path):
        """A dependency's AndroidManifest is not this project's."""
        _android_native(tmp_path / "node_modules" / "some-lib")
        (tmp_path / "package.json").write_text('{"name": "web"}', encoding="utf-8")
        assert detect_stack(tmp_path) is None


class TestTargetNormalisation:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("android", (ANDROID,)),
            ("apple", (IOS,)),
            ("iphone,android", (ANDROID, IOS)),
            (["iOS", "Android"], (ANDROID, IOS)),
            ("android android", (ANDROID,)),
            ("", ()),
            ("windows", ()),
            (None, ()),
        ],
    )
    def test_targets_are_read_and_ordered(self, raw, expected):
        assert normalise_targets(raw) == expected

    def test_order_does_not_depend_on_how_the_caller_wrote_it(self):
        # Two tasks asking for the same platforms must produce the same prompt.
        assert normalise_targets("ios,android") == normalise_targets("android,ios")
