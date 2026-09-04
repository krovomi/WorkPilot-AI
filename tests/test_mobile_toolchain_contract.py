"""The mobile layer, run against the machine's **real** toolchain.

Every other mobile test feeds the code a string I wrote. That is how a bug
survived 64 of them: `adb devices -l` on a cold daemon prints two lines of its
own before the header, my fixtures did not, and the device picker would have
offered two phantom devices named `*` the first time anyone opened the Mobile
tab. The fixtures were testing my idea of adb.

So this module tests the contract against whatever is actually installed —
`adb`, `xcrun`, a JDK, or none of them. It asserts what must hold *whatever*
the answer is, never that a particular device exists: a CI image that ships one
simulator fewer is not a defect in this code, and a test that says otherwise
gets disabled within a month.

It runs on Linux, Windows and macOS in the existing `test-python` matrix, which
is the point: the two platforms differ in what they can build, and the honesty
of that answer is the feature.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from mobile import list_devices  # noqa: E402
from mobile.readiness import doctor  # noqa: E402
from mobile.stacks import ANDROID, IOS  # noqa: E402
from mobile.toolchain import find_tool  # noqa: E402

IS_MACOS = sys.platform == "darwin"

# A real (if tiny) Android project, so the per-stack checks — the Gradle and JDK
# ones — are actually part of the verdict. Pointing the doctor at the repo root
# asks about a project that is not a mobile one, and it correctly answers with
# the platform checks alone.
SAMPLE_APP = REPO_ROOT / "tests" / "fixtures" / "android-sample"


class TestItSurvivesTheRealMachine:
    """No crash, whatever is or is not installed. The floor everything sits on."""

    def test_listing_devices_never_raises(self):
        listing = list_devices()
        assert isinstance(listing.devices, tuple)

    def test_every_platform_gets_devices_or_a_reason(self):
        """An empty list with no explanation is the unhelpful answer."""
        listing = list_devices()
        for platform in (ANDROID, IOS):
            found = [d for d in listing.devices if d.platform == platform]
            reason = (listing.unavailable or {}).get(platform)
            assert found or reason, f"{platform}: no devices and no reason given"

    def test_a_reason_is_a_sentence_not_a_shrug(self):
        for platform, reason in (list_devices().unavailable or {}).items():
            assert len(reason) > 30, f"{platform}: {reason!r} explains nothing"

    def test_a_passing_check_carries_no_remedy(self):
        """ "You have Gradle, now commit a wrapper" reads as an open problem."""
        for report in doctor(SAMPLE_APP, platforms=(ANDROID, IOS)).values():
            for check in report.checks:
                if check.ok:
                    assert not check.remedy, f"{check.tool} passed but suggests a fix"

    def test_the_doctor_answers_for_both_platforms(self):
        reports = doctor(SAMPLE_APP, platforms=(ANDROID, IOS))
        assert set(reports) == {ANDROID, IOS}
        for report in reports.values():
            assert report.checks, "a verdict with no checks behind it"
            assert report.ok or report.blocker, "not ok, and no blocker named"


class TestAppleIsMacOSOnly:
    """The constraint the whole feature is shaped around."""

    @pytest.mark.skipif(IS_MACOS, reason="this is the off-macOS contract")
    def test_ios_is_blocked_off_macos(self):
        report = doctor(REPO_ROOT, platforms=(IOS,))[IOS]
        assert not report.ok
        assert "macos" in report.blocker.lower()

    @pytest.mark.skipif(IS_MACOS, reason="this is the off-macOS contract")
    def test_the_remedy_is_a_mac_not_a_package_to_install(self):
        """`xcodebuild` cannot be installed on Linux or Windows.

        Telling an agent to install it sends it after a package that does not
        exist; the honest remedy is a Mac runner or a remote build service.
        """
        remedy = " ".join(
            c.remedy for c in doctor(REPO_ROOT, platforms=(IOS,))[IOS].checks
        ).lower()
        assert "mac" in remedy
        assert "install xcodebuild" not in remedy

    @pytest.mark.skipif(IS_MACOS, reason="this is the off-macOS contract")
    def test_no_simulator_is_invented(self):
        assert not [d for d in list_devices().devices if d.platform == IOS]

    @pytest.mark.skipif(not IS_MACOS, reason="needs macOS")
    def test_macos_finds_apples_toolchain(self):
        assert find_tool("xcrun"), "xcrun missing on a macOS runner"

    @pytest.mark.skipif(not IS_MACOS, reason="needs macOS")
    def test_macos_is_never_told_it_is_the_wrong_platform(self):
        """The blocker, if any, must be a missing piece — not the OS."""
        report = doctor(REPO_ROOT, platforms=(IOS,))[IOS]
        assert "macos-only" not in report.blocker.lower()

    @pytest.mark.skipif(not IS_MACOS, reason="needs macOS")
    def test_simulators_are_read_without_inventing_their_shape(self):
        """Whatever simctl reports must come back well-formed.

        Not "at least one simulator": a runner image with none is not this
        code's defect, and a test that says so gets disabled.
        """
        for device in list_devices((IOS,)).devices:
            assert device.platform == IOS
            assert device.kind == "simulator"
            assert device.id and device.name


class TestAndroidReportsWhatIsThere:
    def test_the_verdict_matches_whether_adb_was_found(self):
        report = doctor(SAMPLE_APP, platforms=(ANDROID,))[ANDROID]
        adb = find_tool("adb")
        if not adb:
            assert not report.ok
            assert "adb" in report.blocker
        else:
            # adb present: any remaining blocker must name a different tool.
            assert "missing: adb" not in report.blocker

    def test_the_emulator_is_optional_and_adb_is_not(self):
        """Building needs adb; only previewing needs an emulator."""
        checks = {
            c.tool: c for c in doctor(REPO_ROOT, platforms=(ANDROID,))[ANDROID].checks
        }
        assert checks["adb"].required
        assert not checks["emulator"].required

    def test_no_device_is_invented_when_adb_reports_none(self):
        """The regression this module exists for.

        A cold adb prints its own startup lines before the header; reading
        those as devices produced entries with the serial `*`.
        """
        for device in list_devices((ANDROID,)).devices:
            assert device.id not in {"*", "List", ""}
            assert device.state != "daemon"
            assert not device.id.startswith("*")


def test_the_sample_app_is_still_a_detectable_android_project():
    """`mobile-device-check.yml` builds this fixture; a rename would silently
    turn that job into a no-op that passes."""
    from mobile import detect_stack

    stack = detect_stack(SAMPLE_APP)
    assert stack is not None, f"{SAMPLE_APP} stopped looking like an Android project"
    assert stack.framework == "android-native"
    assert stack.package_id == "ai.workpilot.sample"
    assert stack.commands_for(ANDROID).build.endswith(":app:assembleDebug")
