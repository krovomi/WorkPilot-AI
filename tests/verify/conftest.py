"""A real FastAPI shop under git, for the verification tests of this folder.

The app is started by the verification itself (`verify.launch`), with the
interpreter running the tests; nothing here fakes the launch, the HTTP calls
or git. The browser is off: these tests are about what happens around it, and
`tests/test_verify_browser.py` drives the real one.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SHOP = """from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
ORDERS = {1: {"id": 1, "email": "a@b.c", "quantity": 2}}


class NewOrder(BaseModel):
    email: str
    quantity: int


@app.get("/api/orders/{order_id}")
def get_order(order_id: int):
    if order_id not in ORDERS:
        raise HTTPException(status_code=404)
    return ORDERS[order_id]


@app.post("/api/orders", status_code=201)
def create_order(order: NewOrder):
    new_id = max(ORDERS) + 1
    ORDERS[new_id] = {"id": new_id, **order.model_dump()}
    return ORDERS[new_id]
"""


def git(repo: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return done.stdout


@pytest.fixture
def shop(tmp_path, monkeypatch):
    """``(project, spec)``: the shop committed on ``main``, a spec beside it."""
    pytest.importorskip("fastapi")
    pytest.importorskip("uvicorn")
    root = tmp_path / "shop"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "verify@example.invalid")
    git(root, "config", "user.name", "Verify Tests")
    git(root, "config", "commit.gpgsign", "false")
    (root / ".gitignore").write_text("__pycache__/\n.workpilot/\n", encoding="utf-8")
    (root / "requirements.txt").write_text("fastapi\nuvicorn\n", encoding="utf-8")
    (root / "main.py").write_text(SHOP, encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-q", "-m", "shop")
    spec = root / ".workpilot" / "specs" / "001-orders"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(
        json.dumps({"phases": []}), encoding="utf-8"
    )
    monkeypatch.setenv(
        "PATH",
        str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
    )
    monkeypatch.setenv("VERIFY_BROWSER", "off")
    monkeypatch.setenv("VERIFY_LAUNCH_TIMEOUT", "40")
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "brain"))
    monkeypatch.delenv("WORKPILOT_VERIFY_LOOP", raising=False)
    monkeypatch.delenv("VERIFY_ENABLED", raising=False)
    return root, spec
