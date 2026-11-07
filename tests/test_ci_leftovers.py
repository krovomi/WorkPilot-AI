"""What the tests leave running is found at the end (tests/ci_leftovers.py)."""

from __future__ import annotations

import subprocess
import sys

import pytest

psutil = pytest.importorskip("psutil")

from tests import ci_leftovers  # noqa: E402


def test_a_process_a_test_left_running_is_found():
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        assert process.pid in {p.pid for p in ci_leftovers.leftovers()}
    finally:
        process.kill()
        process.wait(timeout=10)
    assert process.pid not in {p.pid for p in ci_leftovers.leftovers()}


def test_a_nested_session_stops_nothing(monkeypatch):
    monkeypatch.setenv(ci_leftovers.OWNER, "-1")
    monkeypatch.setenv("CI", "true")
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        assert ci_leftovers.stop_leftovers() == []
        assert process.poll() is None
    finally:
        process.kill()
        process.wait(timeout=10)


def test_off_ci_it_only_names_them(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        named = ci_leftovers.stop_leftovers()
        assert any(f"pid {process.pid}" in line for line in named)
        assert process.poll() is None
    finally:
        process.kill()
        process.wait(timeout=10)


def test_without_psutil_it_finds_nothing_and_raises_nothing(monkeypatch):
    # The lint job's skills harness runs pytest with no psutil installed.
    monkeypatch.setitem(sys.modules, "psutil", None)
    monkeypatch.setenv("CI", "true")
    assert ci_leftovers.leftovers() == []
    assert ci_leftovers.stop_leftovers() == []
