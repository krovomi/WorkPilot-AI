"""The decision is on here: the root conftest runs every suite on the machine."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _placement_decides(monkeypatch):
    monkeypatch.delenv("WORKPILOT_TEST_PLACEMENT", raising=False)
