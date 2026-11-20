"""Fixtures shared by the sandbox tests."""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture
def socket_dir() -> Iterator[Path]:
    """A short folder for a Unix socket.

    A socket path holds at most 104 bytes on macOS (108 on Linux), and
    `tmp_path` there, with the test's name in it, is longer than that.
    """
    folder = Path(tempfile.mkdtemp(prefix="wp-sock-"))
    yield folder
    shutil.rmtree(folder, ignore_errors=True)
