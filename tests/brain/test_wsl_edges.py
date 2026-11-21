"""How WSL is recognised and where the Windows profile is found: the kernel
text, ``/etc/wsl.conf`` and Windows itself, each answering or not."""

from __future__ import annotations

import configparser
import io
import subprocess
import sys

import pytest
from brain import wsl

posix_only = pytest.mark.skipif(
    sys.platform == "win32", reason="WSL is a Linux process; paths here are POSIX"
)


_CACHED = (wsl.is_wsl, wsl.automount_root, wsl.windows_home)


@pytest.fixture(autouse=True)
def _fresh_caches():
    for cached in _CACHED:
        cached.cache_clear()
    yield
    for cached in _CACHED:
        cached.cache_clear()


@pytest.fixture
def linux(monkeypatch):
    monkeypatch.setattr(wsl.sys, "platform", "linux")
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)
    monkeypatch.delenv("WSL_INTEROP", raising=False)


class TestIsWsl:
    def test_the_variables_wsl_sets_are_enough(self, linux, monkeypatch):
        monkeypatch.setenv("WSL_INTEROP", "/run/WSL/1_interop")
        assert wsl.is_wsl() is True

    def test_the_kernel_says_so_where_the_first_probe_is_missing(
        self, linux, monkeypatch
    ):
        def kernel(path, *args, **kwargs):
            if path == "/proc/sys/kernel/osrelease":
                raise FileNotFoundError(path)
            return io.StringIO("Linux version 5.15.167.4-microsoft-standard-WSL2")

        monkeypatch.setattr(wsl, "open", kernel, raising=False)

        assert wsl.is_wsl() is True

    def test_a_plain_linux_kernel_is_not_wsl(self, linux, monkeypatch):
        monkeypatch.setattr(
            wsl,
            "open",
            lambda *_a, **_k: io.StringIO("Linux 6.8.0-generic"),
            raising=False,
        )
        assert wsl.is_wsl() is False


class TestAutomountRoot:
    def read_from(self, monkeypatch, tmp_path, text: str) -> None:
        conf = tmp_path / "wsl.conf"
        conf.write_text(text, encoding="utf-8")

        class Redirected(configparser.ConfigParser):
            def read(self, filenames, encoding=None):
                return super().read(str(conf), encoding=encoding)

        monkeypatch.setattr(wsl.configparser, "ConfigParser", Redirected)

    def test_the_configured_root_quoted_and_without_its_slash(
        self, monkeypatch, tmp_path
    ):
        self.read_from(monkeypatch, tmp_path, '[automount]\nroot = "/win"\n')
        assert wsl.automount_root() == "/win/"

    def test_a_file_without_sections_is_the_default(self, monkeypatch, tmp_path):
        self.read_from(monkeypatch, tmp_path, "root = /win\n")
        assert wsl.automount_root() == "/mnt/"


@posix_only
class TestWindowsHome:
    @pytest.fixture
    def mount(self, tmp_path, monkeypatch):
        mount = tmp_path / "mnt"
        (mount / "c" / "Users" / "Thomas").mkdir(parents=True)
        monkeypatch.setattr(wsl, "is_wsl", lambda: True)
        monkeypatch.setattr(wsl, "automount_root", lambda: f"{mount}/")
        monkeypatch.delenv("USERPROFILE", raising=False)
        return mount

    def answers(self, monkeypatch, stdout: str | None = None, raised=None) -> list:
        calls: list = []

        def run(argv, **kwargs):
            calls.append((argv, kwargs["cwd"]))
            if raised is not None:
                raise raised
            return subprocess.CompletedProcess(argv, 0, stdout, "")

        monkeypatch.setattr(wsl.subprocess, "run", run)
        return calls

    def test_a_shared_profile_variable_is_used_as_it_is(self, mount, monkeypatch):
        monkeypatch.setenv("USERPROFILE", "C:\\Users\\Thomas")
        calls = self.answers(monkeypatch, "")

        assert wsl.windows_home() == str(mount / "c" / "Users" / "Thomas")
        assert calls == []

    def test_windows_is_asked_from_a_drive_folder(self, mount, monkeypatch):
        calls = self.answers(
            monkeypatch,
            "'\\\\wsl.localhost\\Ubuntu'\nCMD.EXE was started with the above path\n"
            "C:\\Users\\Thomas\r\n",
        )

        assert wsl.windows_home() == str(mount / "c" / "Users" / "Thomas")
        [(argv, cwd)] = calls
        assert argv[0] == "cmd.exe" and cwd == f"{mount}/c"

    @pytest.mark.parametrize(
        ("stdout", "raised"),
        [
            (None, FileNotFoundError("cmd.exe")),
            (None, subprocess.TimeoutExpired(["cmd.exe"], 5)),
            ("%USERPROFILE%\n", None),
        ],
    )
    def test_interop_switched_off_or_silent_finds_no_profile(
        self, mount, monkeypatch, stdout, raised
    ):
        self.answers(monkeypatch, stdout, raised)
        assert wsl.windows_home() is None

    def test_a_profile_that_is_not_a_folder_here(self, mount, monkeypatch):
        monkeypatch.setenv("USERPROFILE", "D:\\Users\\Thomas")
        assert wsl.windows_home() is None

    def test_no_windows_profile_outside_wsl(self, monkeypatch):
        monkeypatch.setattr(wsl, "is_wsl", lambda: False)
        assert wsl.windows_home() is None

    def test_a_mount_folder_that_is_not_a_drive_has_no_verdict(self, mount):
        assert wsl.windows_folder_verdict(f"{mount}/wslg/x") is None
