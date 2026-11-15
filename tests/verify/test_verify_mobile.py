"""The mobile half of a verification, platform by platform.

The stack is detected for real from a Flutter project on disk; what needs an
SDK, an emulator or a device — the doctor, the device list, the boot, the
build, the frame, the device log and its numbers — is played by stand-ins of
`mobile.*` that answer in their shapes. What is checked is the verdict each
answer leads to: ``blocked`` (the machine cannot build it), ``no-device``,
``failed`` (build, crash, no frame) and ``verified``.
"""

from __future__ import annotations

import builtins
from pathlib import Path

import mobile.devices as devices_module
import mobile.launch as launch_module
import mobile.readiness as readiness_module
import pytest
from mobile.devices import DeviceListing, MobileDevice
from mobile.readiness import PlatformReport
from verify.mobile import verify_mobile

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


@pytest.fixture
def flutter(tmp_path: Path) -> Path:
    root = tmp_path / "app"
    (root / "android").mkdir(parents=True)
    (root / "ios").mkdir()
    (root / "pubspec.yaml").write_text(
        "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n", encoding="utf-8"
    )
    return root


class Phone:
    """The `mobile.launch` and `mobile.devices` answers of one machine."""

    def __init__(self, monkeypatch, devices=(), *, ready=("android", "ios")):
        self.devices = list(devices)
        self.booted: list[str] = []
        self.built: list[str] = []
        self.boot_answer = (True, "")
        self.build_answer = (True, "BUILD SUCCESSFUL")
        self.launch_answer = (True, "")
        self.frame = True
        self.log = ""
        self.unavailable: dict[str, str] = {}

        def doctor(project, platforms, stack):
            return {
                p: PlatformReport(
                    p, p in ready, (), "" if p in ready else f"{p}: no toolchain here"
                )
                for p in platforms
            }

        def list_devices(platforms):
            return DeviceListing(tuple(self.devices), self.unavailable)

        def boot_device(device):
            self.booted.append(device.id)
            return self.boot_answer

        def build_and_run(stack, platform, project):
            self.built.append(platform)
            return self.build_answer

        def capture_frame(platform, device_id, frame):
            if not self.frame:
                return False
            frame.parent.mkdir(parents=True, exist_ok=True)
            frame.write_bytes(PNG)
            return True

        monkeypatch.setattr(readiness_module, "doctor", doctor)
        monkeypatch.setattr(devices_module, "list_devices", list_devices)
        monkeypatch.setattr(launch_module, "boot_device", boot_device)
        monkeypatch.setattr(launch_module, "build_and_run", build_and_run)
        monkeypatch.setattr(launch_module, "launch_app", lambda *a: self.launch_answer)
        monkeypatch.setattr(launch_module, "capture_frame", capture_frame)
        monkeypatch.setattr(launch_module, "app_log", lambda *a: self.log)
        monkeypatch.setattr(launch_module, "startup_ms", lambda *a: 812.0)
        monkeypatch.setattr(
            launch_module, "jank_stats", lambda *a: {"janky_frames": 3, "total": 120}
        )


PIXEL = MobileDevice("emulator-5554", "Pixel 8", "android", "emulator", "device")
PIXEL_OFF = MobileDevice("Pixel_8_API_35", "Pixel 8", "android", "emulator")
PHONE = MobileDevice("R58M", "Galaxy", "android", "physical")


def test_a_booted_emulator_runs_the_app_and_files_its_frame(
    flutter, tmp_path, monkeypatch
):
    phone = Phone(monkeypatch, [PIXEL_OFF, PIXEL])
    spec = tmp_path / "spec"
    spec.mkdir()

    [result] = verify_mobile(flutter, spec, tmp_path / "verify", ["android"])

    assert result.status == "verified", result.detail
    assert result.device == "Pixel 8 [emulator-5554]"
    assert phone.booted == ["emulator-5554"]  # the booted one, not the first
    assert phone.built == ["android"]
    assert Path(result.frame).read_bytes() == PNG
    assert result.startup_ms == 812.0
    assert result.jank == {"janky_frames": 3, "total": 120}
    assert result.to_dict()["errors"] == []
    # The frame is filed with the task's captures, for visual QA.
    assert any(p.suffix == ".png" for p in (spec / "captures").rglob("*"))


def test_a_platform_the_machine_cannot_build_is_blocked_not_retried(
    flutter, tmp_path, monkeypatch
):
    phone = Phone(monkeypatch, [PIXEL], ready=("android",))

    results = verify_mobile(flutter, None, tmp_path / "verify")

    assert [(r.platform, r.status) for r in results] == [
        ("android", "verified"),
        ("ios", "blocked"),
    ]
    assert results[1].detail == "ios: no toolchain here"
    assert phone.built == ["android"]


def test_a_platform_not_in_the_project_falls_back_to_the_project_s_own(
    flutter, tmp_path, monkeypatch
):
    Phone(monkeypatch, [PIXEL], ready=("android",))
    results = verify_mobile(flutter, None, tmp_path / "verify", ["windows"])
    assert [r.platform for r in results] == ["android", "ios"]


def test_no_emulator_defined_says_why(flutter, tmp_path, monkeypatch):
    phone = Phone(monkeypatch, [PHONE])
    phone.unavailable = {"android": "adb is not on the PATH"}
    [result] = verify_mobile(flutter, None, tmp_path / "verify", ["android"])
    assert (result.status, result.detail) == ("no-device", "adb is not on the PATH")

    phone.unavailable = {}
    [result] = verify_mobile(flutter, None, tmp_path / "verify", ["android"])
    assert result.detail == "no emulator or simulator defined"


def test_an_emulator_that_will_not_boot(flutter, tmp_path, monkeypatch):
    phone = Phone(monkeypatch, [PIXEL_OFF])
    phone.boot_answer = (False, "the emulator did not boot within 180 s")
    [result] = verify_mobile(flutter, None, tmp_path / "verify", ["android"])
    assert result.status == "no-device"
    assert result.device == "Pixel 8"
    assert result.detail == "the emulator did not boot within 180 s"


def test_a_failed_build_is_reported_with_what_it_printed(
    flutter, tmp_path, monkeypatch
):
    phone = Phone(monkeypatch, [PIXEL])
    phone.build_answer = (False, "Error: Gradle task assembleDebug failed: no SDK\n")
    [result] = verify_mobile(flutter, None, tmp_path / "verify", ["android"])
    assert result.status == "failed"
    assert result.detail == "build or install failed"
    assert result.errors[0].source == "build:android"
    assert "assembleDebug" in result.errors[0].message

    phone.build_answer = (False, "")
    [result] = verify_mobile(flutter, None, tmp_path / "verify", ["android"])
    assert result.errors[0].message == "the android run command failed"


def test_without_build_the_installed_app_is_launched(flutter, tmp_path, monkeypatch):
    phone = Phone(monkeypatch, [PIXEL])
    phone.launch_answer = (False, "activity not found, using the default one")
    [result] = verify_mobile(
        flutter, None, tmp_path / "verify", ["android"], build=False
    )
    assert phone.built == []
    assert result.status == "verified"
    assert result.detail == "activity not found, using the default one"


def test_a_crash_in_the_device_log_fails_the_platform(flutter, tmp_path, monkeypatch):
    phone = Phone(monkeypatch, [PIXEL])
    phone.log = "E/flutter: Unhandled exception: Null check operator used\n"
    [result] = verify_mobile(flutter, None, tmp_path / "verify", ["android"])
    assert result.status == "failed"
    assert result.errors[0].kind == "crash"
    assert result.errors[0].source == "device:android"


def test_no_readable_frame_is_a_failure(flutter, tmp_path, monkeypatch):
    phone = Phone(monkeypatch, [PIXEL])
    phone.frame = False
    [result] = verify_mobile(flutter, tmp_path, tmp_path / "verify", ["android"])
    assert result.status == "failed"
    assert result.detail == "no readable frame was captured"


def test_a_frame_that_cannot_be_filed_does_not_fail_the_platform(
    flutter, tmp_path, monkeypatch
):
    Phone(monkeypatch, [PIXEL])
    import docintel.visual_qa as visual_qa

    def refuse(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(visual_qa, "save_capture", refuse)
    [result] = verify_mobile(flutter, tmp_path, tmp_path / "verify", ["android"])
    assert result.status == "verified"


def test_a_project_without_a_mobile_app_has_nothing_to_verify(tmp_path):
    (tmp_path / "main.py").write_text("print('hi')\n", encoding="utf-8")
    assert verify_mobile(tmp_path, None, tmp_path / "verify") == []


def test_without_the_mobile_package_the_platform_is_blocked(
    flutter, tmp_path, monkeypatch
):
    real_import = builtins.__import__

    def without_mobile(name, *args, **kwargs):
        if name.startswith("mobile."):
            raise ImportError(f"No module named {name!r}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_mobile)
    [result] = verify_mobile(flutter, None, tmp_path / "verify")
    assert result.status == "blocked"
    assert result.detail.startswith("unavailable: ")
