"""Fixtures for the WinDev tests: projects in the text and native formats."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.windev.samples import NATIVE, WINDOW, procedure_set, project_file


@pytest.fixture
def text_project(tmp_path: Path) -> Path:
    """A WinDev project saved in the text format, with one binary analysis."""
    (tmp_path / "Gestion.wdp").write_text(project_file(), encoding="utf-8")
    (tmp_path / "COL_Clients.wdg").write_text(procedure_set(), encoding="utf-8")
    (tmp_path / "FEN_Clients.wdw").write_text(WINDOW, encoding="utf-8")
    analysis = tmp_path / "Gestion.ana"
    analysis.mkdir()
    (analysis / "Gestion.wda").write_bytes(NATIVE)
    return tmp_path


@pytest.fixture
def native_project(tmp_path: Path) -> Path:
    """A WinDev project saved in the native, binary format."""
    (tmp_path / "Gestion.wdp").write_bytes(NATIVE)
    (tmp_path / "FEN_Clients.wdw").write_bytes(NATIVE + b"\x99" * 40)
    (tmp_path / "COL_Clients.wdg").write_bytes(NATIVE + b"\x42" * 40)
    return tmp_path
