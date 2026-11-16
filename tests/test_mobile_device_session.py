"""A device session — listing, booting, building, launching, capturing — without a device.

The commands are the product's, run against a scripted toolchain: each test
says what `adb`, `emulator` or `xcrun` answers and checks what the module did
with it (which argv it sent, what it reported). The real-toolchain contract
lives in `test_mobile_toolchain_contract.py` and only runs where the tools
exist; this file runs everywhere.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from mobile import devices as devices_module
from mobile import launch as launch_module
from mobile import toolchain as toolchain_module
from mobile.devices import MobileDevice, list_devices
from mobile.launch import (
    DeviceRun,
    app_log,
    boot_device,
    build_and_run,
    capture_frame,
    is_png,
    jank_stats,
    launch_app,
    startup_ms,
)
from mobile.stacks import ANDROID, IOS, MobileStack, PlatformCommands
from mobile.toolchain import android_sdk_root, clear_cache, find_tool

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8


class Toolchain:
    """`subprocess.run` answering from a script keyed on the argv's words."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.answers: list[tuple[tuple[str, ...], object]] = []

    def answer(self, *words: str, code: int = 0, out: str = "", raises=None):
        self.answers.append((words, raises or (code, out)))

    def run(self, argv, **kwargs):
        argv = list(argv)
        self.calls.append(argv)
        for words, reply in self.answers:
            if all(word in argv for word in words):
                if isinstance(reply, BaseException):
                    raise reply
                code, out = reply
                if "stdout" in kwargs and not isinstance(kwargs["stdout"], int):
                    kwargs["stdout"].write(out if isinstance(out, bytes) else b"")
                    return subprocess.CompletedProcess(argv, code)
                return subprocess.CompletedProcess(argv, code, out, "")
        return subprocess.CompletedProcess(argv, 0, "", "")


@pytest.fixture
def tools(monkeypatch):
    chain = Toolchain()
    for module in (launch_module, devices_module):
        monkeypatch.setattr(module.subprocess, "run", chain.run)
    monkeypatch.setattr(launch_module.time, "sleep", lambda _s: None)
    return chain


def installed(monkeypatch, *names: str) -> None:
    """Make exactly these tools findable, at `/sdk/<name>`."""
    found = {name: f"/sdk/{name}" for name in names}
    for module in (launch_module, devices_module):
        monkeypatch.setattr(module, "find_tool", lambda name: found.get(name, ""))


def android_app(package_id="com.example.app", run="./gradlew installDebug"):
    return MobileStack(
        framework="android-native",
        platforms=(ANDROID,),
        project_dir="",
        commands={ANDROID: PlatformCommands(run=run)},
        package_id=package_id,
    )


def ios_app(package_id="com.example.App"):
    return MobileStack(
        framework="ios-native", platforms=(IOS,), project_dir="", package_id=package_id
    )


# ---------------------------------------------------------------------------
# toolchain


class TestToolchain:
    @pytest.fixture(autouse=True)
    def _fresh(self, monkeypatch, tmp_path):
        for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
            monkeypatch.delenv(var, raising=False)
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
        clear_cache()
        yield
        clear_cache()

    def test_the_environment_names_the_sdk(self, monkeypatch, tmp_path):
        sdk = tmp_path / "sdk"
        sdk.mkdir()
        monkeypatch.setenv("ANDROID_HOME", str(tmp_path / "missing"))
        monkeypatch.setenv("ANDROID_SDK_ROOT", str(sdk))

        assert android_sdk_root() == str(sdk)

    @pytest.mark.parametrize(
        ("windows", "macos", "default"),
        [
            (False, False, "Android/Sdk"),
            (False, True, "Library/Android/sdk"),
            (True, False, "AppData/Local/Android/Sdk"),
        ],
    )
    def test_android_studio_s_default_folder_is_found_without_a_variable(
        self, monkeypatch, tmp_path, windows, macos, default
    ):
        """The regression: the default folders were keyed on "linux" but looked
        up with "OS.LINUX", so they were never searched."""
        sdk = tmp_path / "home" / default
        sdk.mkdir(parents=True)
        monkeypatch.setattr(toolchain_module, "is_windows", lambda: windows)
        monkeypatch.setattr(toolchain_module, "is_macos", lambda: macos)

        assert Path(android_sdk_root()) == sdk.expanduser()

    def test_no_sdk_anywhere_is_an_empty_root(self, monkeypatch):
        monkeypatch.setattr(toolchain_module, "is_windows", lambda: False)
        monkeypatch.setattr(toolchain_module, "is_macos", lambda: True)

        assert android_sdk_root() == ""

    def test_a_tool_under_the_sdk_is_found_when_path_does_not_have_it(
        self, monkeypatch, tmp_path
    ):
        sdk = tmp_path / "sdk"
        (sdk / "platform-tools").mkdir(parents=True)
        (sdk / "platform-tools" / "adb.exe").write_text("", encoding="utf-8")
        monkeypatch.setenv("ANDROID_HOME", str(sdk))
        monkeypatch.setattr(toolchain_module, "find_executable", lambda *a: None)
        monkeypatch.setattr(toolchain_module, "is_windows", lambda: True)

        assert find_tool("adb") == str(sdk / "platform-tools" / "adb.exe")
        assert find_tool("emulator") == ""

    def test_path_answers_first(self, monkeypatch):
        seen = {}

        def on_path(name, extra):
            seen["extra"] = extra
            return f"/usr/bin/{name}"

        monkeypatch.setattr(toolchain_module, "find_executable", on_path)

        assert find_tool("xcrun") == "/usr/bin/xcrun"
        assert seen["extra"] is None


# ---------------------------------------------------------------------------
# listing devices


class TestListing:
    def test_no_sdk_and_no_xcode_say_why(self, monkeypatch, tools):
        installed(monkeypatch)
        monkeypatch.setattr(devices_module, "android_sdk_root", lambda: "/opt/sdk")

        listing = list_devices()

        assert listing.devices == ()
        assert "looked under /opt/sdk" in listing.unavailable[ANDROID]
        assert "xcrun not found" in listing.unavailable[IOS]
        assert tools.calls == []

    def test_a_booted_avd_is_listed_once_by_its_serial(self, monkeypatch, tools):
        installed(monkeypatch, "adb", "emulator")
        tools.answer(
            "-list-avds", out="INFO | boot\nPixel_7\nPixel 8 warning\n\nTablet\n"
        )
        tools.answer(
            "devices",
            "-l",
            out="List of devices attached\n"
            "emulator-5554 device product:x model:Pixel_7\n"
            "R58M device model:Galaxy_S24\n"
            "lonely\n",
        )
        tools.answer("emu", "avd", "name", out="Pixel_7\nOK\n")

        listing = list_devices((ANDROID,))

        assert [(d.id, d.name, d.kind, d.is_booted) for d in listing.devices] == [
            ("R58M", "Galaxy S24", "physical", True),
            ("emulator-5554", "Pixel 7", "emulator", True),
            ("Tablet", "Tablet", "emulator", False),
        ]
        assert listing.to_dict()["unavailable"] == {}

    @pytest.mark.parametrize("emu_out", [(1, "Pixel_7"), (0, "")])
    def test_an_emulator_that_will_not_say_its_name_keeps_its_avd_listed(
        self, monkeypatch, tools, emu_out
    ):
        installed(monkeypatch, "adb", "emulator")
        tools.answer("-list-avds", out="Pixel_7\n")
        tools.answer(
            "devices", "-l", out="List of devices attached\nemulator-5554 device\n"
        )
        tools.answer("emu", "avd", "name", code=emu_out[0], out=emu_out[1])

        names = [d.id for d in list_devices((ANDROID,)).devices]

        assert names == ["emulator-5554", "Pixel_7"]

    def test_failing_android_tools_leave_no_device_and_a_reason(
        self, monkeypatch, tools
    ):
        installed(monkeypatch, "adb", "emulator")
        tools.answer("-list-avds", code=1)
        tools.answer("devices", "-l", raises=subprocess.TimeoutExpired("adb", 20))

        listing = list_devices((ANDROID,))

        assert listing.devices == ()
        assert "no AVD is defined" in listing.unavailable[ANDROID]

    def test_only_one_android_tool_is_enough_to_look(self, monkeypatch, tools):
        installed(monkeypatch, "adb")
        tools.answer("devices", "-l", code=1)

        listing = list_devices((ANDROID,))

        assert ANDROID in listing.unavailable
        assert [call[1] for call in tools.calls] == ["devices"]

    def test_only_the_emulator_lists_the_avds(self, monkeypatch, tools):
        installed(monkeypatch, "emulator")
        tools.answer("-list-avds", out="Pixel_7\n")

        assert [d.id for d in list_devices((ANDROID,)).devices] == ["Pixel_7"]
        assert all("devices" not in call for call in tools.calls)

    def test_simulators_need_xcrun(self, monkeypatch, tools):
        installed(monkeypatch)

        assert devices_module._ios_simulators() == []
        assert tools.calls == []

    def test_simulators_are_read_from_simctl(self, monkeypatch, tools):
        installed(monkeypatch, "xcrun")
        tools.answer(
            "simctl",
            "list",
            out=json.dumps(
                {
                    "devices": {
                        "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
                            {"udid": "A1", "name": "iPhone 16", "state": "Booted"},
                            {"udid": "A2", "name": "iPad", "isAvailable": False},
                            "junk",
                        ],
                        "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": None,
                    }
                }
            ),
        )

        listing = list_devices((IOS,))

        assert [(d.id, d.runtime, d.state) for d in listing.devices] == [
            ("A1", "iOS 18.2", "booted")
        ]

    @pytest.mark.parametrize(
        ("code", "out"),
        [(1, ""), (0, "   "), (0, "{not json"), (0, "[]"), (0, '{"devices": []}')],
    )
    def test_a_simctl_answer_that_lists_nothing_says_why(
        self, monkeypatch, tools, code, out
    ):
        installed(monkeypatch, "xcrun")
        tools.answer("simctl", "list", code=code, out=out)

        listing = list_devices((IOS,))

        assert listing.devices == ()
        assert "no simulator is available" in listing.unavailable[IOS]

    def test_the_listing_reads_back_as_plain_data(self):
        device = MobileDevice("A1", "iPhone", IOS, "simulator", "booted", "iOS 18")

        assert device.to_dict()["isBooted"] is True
        assert devices_module.DeviceListing(devices=(device,)).to_dict() == {
            "devices": [device.to_dict()],
            "unavailable": {},
        }


# ---------------------------------------------------------------------------
# booting


class TestBooting:
    def test_a_booted_device_is_left_alone(self, tools):
        device = MobileDevice("emulator-5554", "Pixel", ANDROID, "emulator", "device")

        assert boot_device(device) == (True, "already booted")
        assert tools.calls == []

    def test_no_emulator_binary_is_reported(self, monkeypatch, tools):
        installed(monkeypatch, "adb")

        ok, detail = boot_device(MobileDevice("Pixel", "Pixel", ANDROID, "emulator"))

        assert not ok and "not on PATH" in detail

    def _start(self, monkeypatch):
        started = []
        monkeypatch.setattr(
            launch_module.subprocess,
            "Popen",
            lambda argv, **kw: started.append(argv),
        )
        return started

    def test_an_avd_boots_headless_and_is_waited_for(self, monkeypatch, tools):
        installed(monkeypatch, "adb", "emulator")
        started = self._start(monkeypatch)
        replies = iter([(1, ""), (0, "0"), (0, "1\n")])
        tools.run = lambda argv, **kw: (
            tools.calls.append(list(argv))
            or subprocess.CompletedProcess(argv, *next(replies), "")
        )
        monkeypatch.setattr(launch_module.subprocess, "run", tools.run)

        ok, detail = boot_device(
            MobileDevice("Pixel_7", "Pixel_7", ANDROID, "emulator")
        )

        assert (ok, detail) == (True, "booted")
        assert started == [
            [
                "/sdk/emulator",
                "-avd",
                "Pixel_7",
                "-no-snapshot-load",
                "-no-audio",
                "-no-window",
            ]
        ]
        assert len(tools.calls) == 3

    def test_an_avd_that_never_boots_times_out(self, monkeypatch, tools):
        installed(monkeypatch, "adb", "emulator")
        self._start(monkeypatch)
        clock = iter([0.0, 0.0, 5.0, 11.0])
        monkeypatch.setattr(launch_module.time, "time", lambda: next(clock))

        ok, detail = boot_device(
            MobileDevice("Pixel_7", "Pixel_7", ANDROID, "emulator"), timeout=10
        )

        assert not ok and "within 10s" in detail

    @pytest.mark.parametrize(
        ("code", "out", "result"),
        [
            (0, "", (True, "booted")),
            (149, "Unable to boot device in current state: Booted", (True, "booted")),
            (1, "  Invalid device: X  ", (False, "Invalid device: X")),
        ],
    )
    def test_a_simulator_boots_through_simctl(
        self, monkeypatch, tools, code, out, result
    ):
        installed(monkeypatch)
        tools.answer("simctl", "boot", code=code, out=out)

        device = MobileDevice("A1", "iPhone", IOS, "simulator")

        assert boot_device(device) == result
        assert tools.calls == [["xcrun", "simctl", "boot", "A1"]]


# ---------------------------------------------------------------------------
# build, launch, capture, measure


class TestTheSession:
    def test_the_stack_s_own_run_command_is_split_and_run_in_its_folder(
        self, tools, tmp_path
    ):
        tools.answer("installDebug", out="x" * 7000)

        ok, tail = build_and_run(android_app(), ANDROID, tmp_path)

        assert ok and len(tail) == 6000
        assert tools.calls == [["./gradlew", "installDebug"]]

    def test_no_run_command_is_not_a_build(self, tools, tmp_path):
        ok, detail = build_and_run(android_app(run=""), IOS, tmp_path)

        assert not ok and "no run command known for ios" in detail
        assert tools.calls == []

    def test_a_build_that_cannot_start_reports_why(self, monkeypatch, tmp_path):
        def missing(*_a, **_kw):
            raise FileNotFoundError("gradlew")

        monkeypatch.setattr(launch_module.subprocess, "run", missing)

        ok, detail = build_and_run(android_app(), ANDROID, tmp_path)

        assert not ok and "gradlew" in detail

    def test_an_android_app_is_launched_by_its_package(self, monkeypatch, tools):
        installed(monkeypatch, "adb")
        tools.answer("monkey", out="Events injected: 1\n")

        assert launch_app(android_app(), ANDROID, "emulator-5554") == (
            True,
            "Events injected: 1",
        )
        assert tools.calls[0][:6] == [
            "/sdk/adb",
            "-s",
            "emulator-5554",
            "shell",
            "monkey",
            "-p",
        ]

    def test_an_ios_app_is_launched_by_its_bundle(self, monkeypatch, tools):
        installed(monkeypatch, "xcrun")
        tools.answer("launch", code=1, out="not installed")

        assert launch_app(ios_app(), IOS, "A1") == (False, "not installed")
        assert tools.calls == [
            ["/sdk/xcrun", "simctl", "launch", "A1", "com.example.App"]
        ]

    @pytest.mark.parametrize("platform", [ANDROID, IOS])
    def test_without_an_id_the_run_command_already_launched_it(self, tools, platform):
        stack = android_app(package_id="") if platform == ANDROID else ios_app("")

        ok, detail = launch_app(stack, platform, "dev")

        assert ok and "run command started the app" in detail
        assert tools.calls == []

    def test_an_android_frame_is_captured_in_binary(self, monkeypatch, tools, tmp_path):
        installed(monkeypatch, "adb")
        tools.answer("screencap", out=PNG)
        frame = tmp_path / "shots" / "frame.png"

        assert capture_frame(ANDROID, "emulator-5554", frame) is True
        assert frame.read_bytes() == PNG

    def test_an_empty_capture_is_not_a_frame(self, monkeypatch, tools, tmp_path):
        installed(monkeypatch, "adb")
        tools.answer("screencap", out=b"")

        assert capture_frame(ANDROID, "emulator-5554", tmp_path / "f.png") is False

    def test_a_capture_that_cannot_run_is_not_a_frame(self, monkeypatch, tmp_path):
        def gone(*_a, **_kw):
            raise subprocess.TimeoutExpired("adb", 60)

        monkeypatch.setattr(launch_module.subprocess, "run", gone)

        assert capture_frame(ANDROID, "emulator-5554", tmp_path / "f.png") is False

    def test_an_ios_frame_is_written_by_simctl(self, monkeypatch, tools, tmp_path):
        installed(monkeypatch, "xcrun")
        frame = tmp_path / "frame.png"

        def screenshot(argv, **kw):
            Path(argv[-1]).write_bytes(PNG)
            return subprocess.CompletedProcess(argv, 0, "", "")

        monkeypatch.setattr(launch_module.subprocess, "run", screenshot)

        assert capture_frame(IOS, "A1", frame) is True

    def test_a_missing_frame_file_is_not_a_png(self, tmp_path):
        assert is_png(tmp_path / "missing.png") is False

    def test_the_android_log_is_the_app_s_own(self, monkeypatch, tools):
        installed(monkeypatch, "adb")
        tools.answer("pidof", out="4242\n")
        tools.answer("logcat", out="I/App: started\n")

        assert app_log(android_app(), ANDROID, "emulator-5554", lines=50) == (
            "I/App: started\n"
        )
        assert tools.calls[-1][-2:] == ["--pid", "4242"]
        assert "50" in tools.calls[-1]

    @pytest.mark.parametrize("package_id", ["com.example.app", ""])
    def test_without_a_running_process_the_crashes_are_read(
        self, monkeypatch, tools, package_id
    ):
        installed(monkeypatch, "adb")
        tools.answer("pidof", out="")

        app_log(android_app(package_id=package_id), ANDROID, "emulator-5554")

        assert tools.calls[-1][-2:] == ["AndroidRuntime:E", "*:S"]

    @pytest.mark.parametrize(
        ("package_id", "predicate"),
        [
            (
                "com.example.App",
                'subsystem == "com.example.App" OR process == "App"',
            ),
            ("", 'eventType == "logEvent"'),
        ],
    )
    def test_the_ios_log_is_filtered_to_the_app(
        self, monkeypatch, tools, package_id, predicate
    ):
        installed(monkeypatch, "xcrun")
        tools.answer("log", "show", out="z" * 25_000)

        assert len(app_log(ios_app(package_id), IOS, "A1")) == 20_000
        assert tools.calls[-1][-1] == predicate

    def test_the_cold_start_time_comes_from_am_start(self, monkeypatch, tools):
        installed(monkeypatch, "adb")
        tools.answer(
            "resolve-activity",
            out="priority=0 preferredOrder=0\ncom.example.app/.MainActivity\n",
        )
        tools.answer("start", "-W", out="Status: ok\nTotalTime: 812\n")

        assert startup_ms(android_app(), ANDROID, "emulator-5554") == 812.0
        assert tools.calls[-1][-2:] == ["-n", "com.example.app/.MainActivity"]

    @pytest.mark.parametrize(
        ("resolved", "started"),
        [("No activity found", ""), ("com.example.app/.Main", "Status: timeout")],
    )
    def test_an_unmeasured_start_is_none(self, monkeypatch, tools, resolved, started):
        installed(monkeypatch, "adb")
        tools.answer("resolve-activity", out=resolved)
        tools.answer("start", "-W", out=started)

        assert startup_ms(android_app(), ANDROID, "emulator-5554") is None

    def test_jank_is_read_from_gfxinfo(self, monkeypatch, tools):
        installed(monkeypatch, "adb")
        tools.answer(
            "gfxinfo",
            out="Total frames rendered: 240\nJanky frames: 12 (5.00%)\n"
            "90th percentile: 14ms\n",
        )

        assert jank_stats(android_app(), ANDROID, "emulator-5554") == {
            "frames": 240,
            "janky": 12,
            "p90_ms": 14,
        }

    @pytest.mark.parametrize(
        ("stack", "platform"),
        [(ios_app(), IOS), (android_app(package_id=""), ANDROID)],
    )
    def test_measurements_are_android_and_package_only(self, tools, stack, platform):
        assert startup_ms(stack, platform, "dev") is None
        assert jank_stats(stack, platform, "dev") == {}
        assert tools.calls == []

    def test_a_run_reads_back_as_plain_data(self):
        run = DeviceRun(platform=ANDROID, device_id="emulator-5554", built=True)

        assert run.to_dict()["built"] is True and run.to_dict()["steps"] == []
