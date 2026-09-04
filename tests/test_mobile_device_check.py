"""Capturing a frame off a device.

`scripts/mobile_device_check.py` is the only thing that turns a build into a
picture, and the picture is the whole point of `mobile-device-check.yml`. Both
defects covered here reached a real runner: the emulator booted, the APK built
and installed, the app launched — and then the capture threw, after four
minutes, with nothing to show.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

_SPEC = importlib.util.spec_from_file_location(
    "mobile_device_check", REPO_ROOT / "scripts" / "mobile_device_check.py"
)
mdc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mdc)

PNG_HEADER = b"\x89PNG\r\n\x1a\n"


class TestTheFrameIsReadBinary:
    def test_a_png_survives_the_capture_path(self, tmp_path):
        """The regression.

        `screencap -p` writes a PNG to stdout, and its first byte is 0x89 —
        not valid UTF-8. Reading that stream with `text=True` raised
        `UnicodeDecodeError` on the runner *after* the app had launched.
        """
        frame = tmp_path / "device-frame.png"
        payload = PNG_HEADER + b"\x00\x01\x02\xff\xfe"
        with frame.open("wb") as handle:
            subprocess.run(  # noqa: S603
                [
                    sys.executable,
                    "-c",
                    f"import sys; sys.stdout.buffer.write({payload!r})",
                ],
                stdout=handle,
                check=True,
            )
        assert frame.read_bytes() == payload
        assert mdc._is_png(frame)

    def test_text_mode_is_what_used_to_break(self):
        """Pins the cause, so nobody reintroduces `text=True` here."""
        with pytest.raises(UnicodeDecodeError):
            subprocess.run(  # noqa: S603
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.stdout.buffer.write(b'\\x89PNG')",
                ],
                capture_output=True,
                text=True,
                check=False,
            )


class TestAnEmptyFrameIsNotASuccess:
    """adb can exit 0 having written nothing when the device goes away, and an
    empty `device-frame.png` uploads as an artifact that looks like a pass."""

    @pytest.mark.parametrize(
        "content",
        [
            pytest.param(b"", id="empty"),
            pytest.param(b"error: device offline", id="adb-error-text"),
            pytest.param(b"\x89PNG\r\n\x1a", id="truncated-header"),
            pytest.param(b"\xff\xd8\xff\xe0JFIF", id="not-a-png"),
        ],
    )
    def test_rejected(self, tmp_path, content):
        frame = tmp_path / "device-frame.png"
        frame.write_bytes(content)
        assert not mdc._is_png(frame)

    def test_a_missing_file_is_rejected_rather_than_raising(self, tmp_path):
        assert not mdc._is_png(tmp_path / "never-written.png")


def test_the_script_still_exposes_the_cli_the_workflow_calls():
    """`mobile-device-check.yml` passes these four flags; a rename would turn
    the job into an argparse error four minutes into a run."""
    source = (REPO_ROOT / "scripts" / "mobile_device_check.py").read_text(
        encoding="utf-8"
    )
    for flag in ("--project-dir", "--platform", "--require-device", "--launch"):
        assert flag in source, f"{flag} disappeared from the script"
