"""Mobile stacks beyond the common ones, and projects of odd shapes.

`test_mobile_stacks.py` covers native Android and iOS, Flutter, Expo, bare
React Native and MAUI's target frameworks. This file covers Capacitor, Kotlin
Multiplatform, a Swift package, the MAUI fallbacks, and what detection does
with a folder it cannot read or a manifest of another shape: it says "not a
mobile project" (or finds the app elsewhere), it never raises.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from mobile import stacks as stacks_module
from mobile.stacks import (
    ANDROID,
    IOS,
    MobileStack,
    detect_stack,
    normalise_targets,
)


def _write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


class TestCapacitor:
    def test_a_config_file_with_both_native_folders(self, tmp_path):
        _write(tmp_path / "capacitor.config.ts", "export default {}")
        (tmp_path / "android").mkdir()
        (tmp_path / "ios").mkdir()

        stack = detect_stack(tmp_path)

        assert stack.framework == "capacitor"
        assert stack.platforms == (ANDROID, IOS) and stack.is_cross_platform
        assert stack.commands_for(IOS).run == "npx cap run ios"

    def test_a_dependency_alone_targets_both_platforms(self, tmp_path):
        _write(
            tmp_path / "package.json",
            '{"dependencies": {"@capacitor/core": "6"}, "devDependencies": []}',
        )

        stack = detect_stack(tmp_path)

        assert stack.framework == "capacitor"
        assert stack.platforms == (ANDROID, IOS)

    def test_only_the_android_folder_means_android_only(self, tmp_path):
        _write(tmp_path / "capacitor.config.json", "{}")
        (tmp_path / "android").mkdir()

        stack = detect_stack(tmp_path)

        assert stack.platforms == (ANDROID,)
        assert set(stack.to_dict()["commands"]) == {ANDROID}


class TestKotlinMultiplatform:
    def test_both_heads(self, tmp_path):
        _write(
            tmp_path / "settings.gradle.kts",
            'plugins { kotlin("multiplatform") }\ninclude(":shared")',
        )
        (tmp_path / "iosApp").mkdir()
        (tmp_path / "androidApp").mkdir()
        _write(tmp_path / "gradlew")

        stack = detect_stack(tmp_path)

        assert stack.framework == "kotlin-multiplatform"
        assert stack.platforms == (ANDROID, IOS)
        assert stack.commands_for(ANDROID).run == "./gradlew :androidApp:installDebug"

    def test_ios_targets_named_in_the_build_without_an_android_head(self, tmp_path):
        _write(
            tmp_path / "build.gradle",
            "kotlin-multiplatform\nkotlin { iosSimulatorArm64() }",
        )

        stack = detect_stack(tmp_path)

        assert stack.platforms == (IOS,)
        assert stack.commands_for(IOS).build.startswith("gradle ")

    def test_a_multiplatform_library_with_no_head_is_not_an_app(self, tmp_path):
        _write(tmp_path / "settings.gradle", "kotlin-multiplatform\njvm()")

        assert detect_stack(tmp_path) is None


class TestOtherShapes:
    def test_a_swift_package_for_ios_is_an_ios_app(self, tmp_path):
        project = tmp_path / "Pocket"
        _write(project / "Package.swift", "platforms: [.iOS(.v17)]")

        stack = detect_stack(project)

        assert stack.platforms == (IOS,)
        assert '-scheme "Pocket"' in stack.commands_for(IOS).build
        assert "-workspace" not in stack.commands_for(IOS).build

    def test_a_swift_package_for_macos_only_is_not(self, tmp_path):
        _write(tmp_path / "Package.swift", "platforms: [.macOS(.v14)]")

        assert detect_stack(tmp_path) is None

    def test_maui_without_target_frameworks_assumes_android(self, tmp_path):
        _write(tmp_path / "Empty.csproj", "")
        _write(
            tmp_path / "App" / "App.csproj",
            "<Project><PropertyGroup><UseMaui>true</UseMaui></PropertyGroup></Project>",
        )

        stack = detect_stack(tmp_path)

        assert stack.framework == "dotnet-maui" and stack.platforms == (ANDROID,)
        assert "-f net10.0-android" in stack.commands_for(ANDROID).run

    def test_maui_targeting_ios_only(self, tmp_path):
        _write(
            tmp_path / "App.csproj",
            "<Project><UseMaui>true</UseMaui>"
            "<TargetFramework>net10.0-ios</TargetFramework></Project>",
        )

        stack = detect_stack(tmp_path)

        assert stack.platforms == (IOS,)
        assert "-f net10.0-ios" in stack.commands_for(IOS).run

    def test_a_dotnet_project_that_is_not_maui_is_not_an_app(self, tmp_path):
        _write(tmp_path / "Api.csproj", "<Project Sdk='Microsoft.NET.Sdk.Web' />")

        assert detect_stack(tmp_path) is None

    @pytest.mark.parametrize(
        "body", ["{broken", '["react-native"]', '{"dependencies": ["react-native"]}']
    )
    def test_a_package_json_of_another_shape_is_not_an_app(self, tmp_path, body):
        _write(tmp_path / "package.json", body)
        (tmp_path / "android").mkdir()

        assert detect_stack(tmp_path) is None

    def test_react_native_without_native_folders_is_not_an_app(self, tmp_path):
        _write(tmp_path / "package.json", '{"dependencies": {"react-native": "0.76"}}')

        assert detect_stack(tmp_path) is None

    def test_react_native_with_only_an_ios_folder_is_an_ios_app(self, tmp_path):
        _write(tmp_path / "package.json", '{"dependencies": {"react-native": "0.76"}}')
        (tmp_path / "ios").mkdir()

        assert detect_stack(tmp_path).platforms == (IOS,)

    def test_an_unreadable_subfolder_is_skipped_and_the_app_found_elsewhere(
        self, tmp_path, monkeypatch
    ):
        locked = tmp_path / "locked"
        locked.mkdir()
        _write(tmp_path / "mobile" / "capacitor.config.ts")
        real_iterdir = Path.iterdir

        def iterdir(self):
            if self == locked:
                raise PermissionError(self)
            return real_iterdir(self)

        monkeypatch.setattr(Path, "iterdir", iterdir)

        stack = detect_stack(tmp_path)

        assert stack.framework == "capacitor"
        assert stack.project_dir == str(tmp_path / "mobile")

    def test_a_folder_that_cannot_be_listed_is_not_an_ios_app(
        self, tmp_path, monkeypatch
    ):
        def refuse(self):
            raise PermissionError(self)

        monkeypatch.setattr(Path, "iterdir", refuse)

        assert stacks_module._detect_ios_native(tmp_path) is None

    def test_a_folder_whose_projects_cannot_be_globbed_is_not_maui(
        self, tmp_path, monkeypatch
    ):
        def refuse(self, pattern):
            raise PermissionError(self)

        monkeypatch.setattr(Path, "glob", refuse)

        assert stacks_module._detect_maui(tmp_path) is None

    def test_a_detector_that_fails_gives_way_to_the_next(self, tmp_path, monkeypatch):
        _write(tmp_path / "capacitor.config.ts")

        def broken(_directory):
            raise RuntimeError("detector bug")

        monkeypatch.setattr(
            stacks_module,
            "_DETECTORS",
            (broken, *stacks_module._DETECTORS),
        )

        assert detect_stack(tmp_path).framework == "capacitor"


@pytest.mark.parametrize("targets", [42, {"android": True}, None])
def test_targets_of_another_type_are_none(targets):
    assert normalise_targets(targets) == ()


def test_a_single_platform_stack_is_not_cross_platform():
    stack = MobileStack(framework="x", platforms=(ANDROID,), project_dir="")

    assert stack.is_cross_platform is False
