"""The mobile doctor, the prompt section and the setup profile, at their edges.

The doctor's verdict and the prompt section are phase inputs: they must say
the same thing whatever the machine has, and the section must never stop a
phase. The toolchain is replaced by a set of "installed" tool names, and the
host OS by a flag, so each answer is checked on every platform.
"""

from __future__ import annotations

import types
from pathlib import Path

import pytest
from mobile import bootstrap as bootstrap_module
from mobile import prompt as prompt_module
from mobile import readiness as readiness_module
from mobile.bootstrap import host_stacks, mobile_profile
from mobile.prompt import mobile_section
from mobile.readiness import doctor
from mobile.stacks import ANDROID, IOS, MobileStack, PlatformCommands


def _write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def machine(monkeypatch):
    """Tools installed here, and whether this is a Mac."""
    state = types.SimpleNamespace(tools=set(), mac=False)
    monkeypatch.setattr(
        readiness_module,
        "find_tool",
        lambda name: f"/bin/{name}" if name in state.tools else "",
    )
    monkeypatch.setattr(
        readiness_module.shutil,
        "which",
        lambda name: f"/usr/bin/{name}" if name in state.tools else None,
    )
    monkeypatch.setattr(readiness_module, "is_macos", lambda: state.mac)
    monkeypatch.setattr(readiness_module, "android_sdk_root", lambda: "")
    return state


def ios_stack(project_dir: Path, framework: str = "ios-native") -> MobileStack:
    return MobileStack(
        framework=framework,
        platforms=(IOS,),
        project_dir=str(project_dir),
        commands={IOS: PlatformCommands(run="xcodebuild build")},
    )


# ---------------------------------------------------------------------------
# the doctor


class TestDoctor:
    def test_with_no_project_both_platforms_are_checked(self, machine, tmp_path):
        machine.tools = {"adb", "sdkmanager"}

        reports = doctor(tmp_path)

        assert set(reports) == {ANDROID, IOS}
        assert [c.tool for c in reports[ANDROID].checks][:1] == ["adb"]
        assert reports[IOS].blocker.startswith("iOS cannot be built on this machine")
        assert reports[IOS].to_dict()["checks"][0]["tool"] == "xcodebuild"

    def test_a_mac_with_xcode_and_cocoapods_can_build_ios(self, machine, tmp_path):
        machine.mac = True
        machine.tools = {"xcodebuild", "xcrun", "pod", "flutter"}
        _write(tmp_path / "Podfile")

        report = doctor(stack=ios_stack(tmp_path, "flutter"), platforms=(IOS,))[IOS]

        assert report.ok and report.blocker == ""
        assert [c.tool for c in report.checks] == [
            "xcodebuild",
            "xcrun",
            "flutter",
            "pod",
        ]

    def test_a_project_without_a_podfile_needs_no_cocoapods(self, machine, tmp_path):
        machine.mac = True
        machine.tools = {"xcodebuild", "xcrun"}

        report = doctor(stack=ios_stack(tmp_path), platforms=(IOS,))[IOS]

        assert report.ok
        assert [c.tool for c in report.checks] == ["xcodebuild", "xcrun"]

    def test_a_mac_missing_its_tools_names_them(self, machine, tmp_path):
        machine.mac = True

        report = doctor(stack=ios_stack(tmp_path), platforms=(IOS,))[IOS]

        assert not report.ok
        assert report.blocker == "missing: xcodebuild, xcrun"
        assert doctor(tmp_path / "empty", platforms=(IOS,))[IOS].blocker == (
            report.blocker
        )
        assert report.to_dict()["checks"][0]["remedy"].startswith("Install Xcode")

    def test_a_check_reads_back_as_plain_data(self, machine, tmp_path):
        machine.tools = {"adb"}

        check = doctor(tmp_path, platforms=(ANDROID,))[ANDROID].checks[0]

        assert check.to_dict() == {
            "tool": "adb",
            "ok": True,
            "detail": "/bin/adb",
            "remedy": "",
            "required": True,
        }


# ---------------------------------------------------------------------------
# the prompt section


class TestPromptSection:
    @pytest.fixture
    def stack(self, monkeypatch, tmp_path):
        stack = MobileStack(
            framework="android-native",
            platforms=(ANDROID,),
            project_dir=str(tmp_path),
            commands={
                ANDROID: PlatformCommands(
                    run="./gradlew installDebug",
                    artifact="app/build/outputs/apk/debug/app-debug.apk",
                    notes="Boot an emulator first.",
                )
            },
        )
        monkeypatch.setattr(prompt_module, "detect_stack", lambda _p: stack)
        return stack

    def test_empty_commands_are_left_out_and_the_artefact_named(self, stack, tmp_path):
        section = mobile_section(tmp_path, include_doctor=False)

        assert "- Run on a booted device: `./gradlew installDebug`" in section
        assert "- Build:" not in section and "- Test:" not in section
        assert "- Artefact: `app/build/outputs/apk/debug/app-debug.apk`" in section
        assert "- Watch out: Boot an emulator first." in section
        assert "Its mobile root is" in section and "(`" not in section.split("\n")[3]

    def test_a_platform_with_only_a_run_command_lists_just_that(
        self, monkeypatch, tmp_path
    ):
        bare = ios_stack(tmp_path)
        monkeypatch.setattr(prompt_module, "detect_stack", lambda _p: bare)

        section = mobile_section(tmp_path, targets=(IOS,), include_doctor=False)
        block = section.split("### iOS")[1].split("##")[0]

        assert [line for line in block.splitlines() if line.startswith("- ")] == [
            "- Run on a booted device: `xcodebuild build`"
        ]

    def test_a_machine_that_can_build_adds_no_blocked_section(
        self, stack, monkeypatch, tmp_path
    ):
        ok = types.SimpleNamespace(ok=True, platform=ANDROID, blocker="", checks=())
        monkeypatch.setattr(prompt_module, "doctor", lambda *a, **kw: {ANDROID: ok})

        assert "What this machine cannot do" not in mobile_section(tmp_path)

    def test_a_blocked_platform_without_a_remedy_still_says_so(
        self, stack, monkeypatch, tmp_path
    ):
        blocked = types.SimpleNamespace(
            ok=False,
            platform=ANDROID,
            blocker="missing: adb",
            checks=(types.SimpleNamespace(remedy=""),),
        )
        monkeypatch.setattr(
            prompt_module, "doctor", lambda *a, **kw: {ANDROID: blocked}
        )

        section = mobile_section(tmp_path)

        assert "- **Android** — missing: adb." in section
        line = section.split("- **Android** — missing: adb.")[1].splitlines()[1]
        assert not line.startswith("  ")

    def test_a_failure_building_the_section_leaves_no_section(
        self, monkeypatch, tmp_path
    ):
        def broken(_project):
            raise RuntimeError("detector bug")

        monkeypatch.setattr(prompt_module, "detect_stack", broken)

        assert mobile_section(tmp_path) == ""


# ---------------------------------------------------------------------------
# the setup profile


class TestSetupProfile:
    def test_a_missing_folder_has_no_stacks_and_no_profile(self, tmp_path):
        assert host_stacks(tmp_path / "missing") == []
        assert mobile_profile(tmp_path / "missing") == {
            "success": False,
            "isMobile": False,
            "error": "Directory not found",
        }

    @pytest.mark.parametrize("body", ["{broken", "[1, 2]"])
    def test_a_package_json_of_another_shape_is_no_javascript_stack(
        self, tmp_path, body
    ):
        _write(tmp_path / "package.json", body)
        _write(tmp_path / "go.mod", "module x")

        assert host_stacks(tmp_path) == ["go"]

    def test_an_unreadable_folder_is_skipped(self, tmp_path, monkeypatch):
        _write(tmp_path / "locked" / "Cargo.toml")
        _write(tmp_path / "api" / "go.mod")
        locked = tmp_path / "locked"
        real = Path.iterdir

        def iterdir(self):
            if self == locked:
                raise PermissionError(self)
            return real(self)

        monkeypatch.setattr(Path, "iterdir", iterdir)

        assert "go" in host_stacks(tmp_path)

    def test_the_walk_stops_at_its_folder_budget(self, tmp_path, monkeypatch):
        monkeypatch.setattr(bootstrap_module, "_MAX_DIRS", 3)
        for name in ("a", "b", "c", "d"):
            (tmp_path / name / "sub").mkdir(parents=True)

        assert len(bootstrap_module._shallow_dirs(tmp_path)) == 3

    def test_a_windev_project_with_a_mobile_configuration_is_a_mobile_app(
        self, tmp_path, monkeypatch
    ):
        import windev.project

        monkeypatch.setattr(
            windev.project,
            "detect_project",
            lambda _root: types.SimpleNamespace(mobile_platforms=["android"]),
        )

        assert mobile_profile(tmp_path) == {
            "success": True,
            "isMobile": True,
            "windev": True,
            "stack": {"framework": "windev-mobile", "platforms": ["android"]},
        }

    def test_a_windev_project_without_one_has_nothing_to_install(
        self, tmp_path, monkeypatch
    ):
        import windev.project

        monkeypatch.setattr(
            windev.project,
            "detect_project",
            lambda _root: types.SimpleNamespace(mobile_platforms=[]),
        )

        assert mobile_profile(tmp_path) == {
            "success": True,
            "isMobile": False,
            "windev": True,
            "hostStacks": ["windev"],
            "frameworks": [],
        }
