"""The verification loop end to end, on a real FastAPI app.

No model: the `AgentRunner` is a fake that does what a fixer and a verifier
would — the fixer rewrites the file the error points at, the verifier records
what it confirmed through the same `verify_*` tools every provider gets. The
app, the launch, the logs, the OpenAPI document, the endpoint calls and the
verdict are all real.

The browser is off here (`VERIFY_BROWSER=off`) to keep the suite fast and
offline; `test_verify_browser.py` drives the real one.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

pytest.importorskip("fastapi")
pytest.importorskip("uvicorn")

from verify.loop import LoopOptions, run_verify_loop  # noqa: E402
from verify.record import load_record  # noqa: E402
from verify.state import load_state  # noqa: E402
from verify.tools import execute_tool  # noqa: E402

FIXED = """from fastapi import FastAPI, HTTPException
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

BROKEN = FIXED.replace(
    "app = FastAPI()",
    'raise RuntimeError("settings: ORDERS_DB is not configured")\napp = FastAPI()',
)


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "shop"
    root.mkdir()
    (root / "requirements.txt").write_text("fastapi\nuvicorn\n", encoding="utf-8")
    (root / "main.py").write_text(BROKEN, encoding="utf-8")
    spec = root / ".workpilot" / "specs" / "001-orders"
    spec.mkdir(parents=True)
    (spec / "implementation_plan.json").write_text(
        json.dumps({"phases": []}), encoding="utf-8"
    )
    # The app is started with the interpreter running the tests.
    monkeypatch.setenv(
        "PATH",
        str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
    )
    monkeypatch.setenv("VERIFY_BROWSER", "off")
    monkeypatch.setenv("VERIFY_LAUNCH_TIMEOUT", "40")
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "brain"))
    monkeypatch.delenv("WORKPILOT_VERIFY_LOOP", raising=False)
    return root, spec


def test_the_loop_fixes_launches_calls_and_records(project):
    root, spec = project
    calls: list[str] = []

    async def runner(agent_type: str, prompt: str):
        calls.append(agent_type)
        if agent_type == "qa_fixer":
            assert "ORDERS_DB is not configured" in prompt
            (root / "main.py").write_text(FIXED, encoding="utf-8")
            return "complete", "Removed the import-time check."
        assert agent_type == "verifier"
        assert "/api/orders" in prompt  # the prepared calls reached the prompt
        await execute_tool(
            "verify_call_endpoint",
            {
                "method": "POST",
                "path": "/api/orders",
                "body": {"email": "x@y.z", "quantity": 3},
            },
            project_dir=root,
            spec_dir=spec,
        )
        await execute_tool(
            "verify_record",
            {"kind": "confirm", "state": "order 2 created", "evidence": '"id": 2'},
            project_dir=root,
            spec_dir=spec,
        )
        await execute_tool(
            "verify_record",
            {"kind": "verdict", "verdict": "pass", "summary": "ok"},
            project_dir=root,
            spec_dir=spec,
        )
        return "complete", "Verify: pass"

    record = asyncio.run(
        run_verify_loop(
            root,
            spec,
            runner,
            LoopOptions(provider="ollama", effort="medium", changed_files=["main.py"]),
        )
    )

    assert calls == ["qa_fixer", "verifier"]
    assert record["status"] == "pass", record["reason"]
    assert record["rounds"][0]["errors_before"] >= 1
    assert record["rounds"][0]["fixed"] is True

    endpoints = {(e["method"], e["path"]): e for e in record["endpoints"]}
    created = endpoints[("POST", "/api/orders")]
    assert (
        created["status"] == 201
        and created["ok"]
        and created["schema_ok"] in (True, None)
    )
    assert record["confirmations"][0]["state"] == "order 2 created"
    assert record["latency"]["count"] >= 1
    assert record["score"] is not None

    # What the next task inherits, and what everyone reads.
    recipe = json.loads((root / ".workpilot" / "verify" / "recipe.json").read_text())
    assert "{port}" in recipe["targets"]["fastapi"]["command"]
    plan = json.loads((spec / "implementation_plan.json").read_text())
    assert plan["verification"]["status"] == "pass"
    assert load_record(spec / "verify")["status"] == "pass"
    assert (spec / "verify" / "report.md").read_text().rstrip().endswith("Verify: pass")
    # Nothing is left running.
    assert load_state(spec / "verify")["processes"] == {}


def test_low_effort_calls_the_touched_endpoints_without_a_verifier(project):
    root, spec = project
    (root / "main.py").write_text(FIXED, encoding="utf-8")
    seen: list[str] = []

    async def runner(agent_type: str, prompt: str):
        seen.append(agent_type)
        return "complete", ""

    record = asyncio.run(
        run_verify_loop(
            root, spec, runner, LoopOptions(effort="low", changed_files=["main.py"])
        )
    )
    assert seen == []  # nothing to fix, no driving at low effort
    assert record["status"] == "pass", record["reason"]
    methods = {(e["method"], e["path"], e["status"]) for e in record["endpoints"]}
    assert ("GET", "/api/orders/1", 200) in methods
    assert ("POST", "/api/orders", 201) in methods
    # The negative call: the API refuses an empty body.
    assert any(
        e["method"] == "POST" and e["status"] == 422 and e["ok"]
        for e in record["endpoints"]
    )


def test_a_bug_the_fixer_cannot_fix_stops_on_progress_not_on_count(
    project, monkeypatch
):
    root, spec = project
    monkeypatch.setenv("VERIFY_MAX_ROUNDS", "10")
    fixer_calls = 0

    async def runner(agent_type: str, prompt: str):
        nonlocal fixer_calls
        fixer_calls += 1
        return "complete", "I tried."

    record = asyncio.run(
        run_verify_loop(
            root, spec, runner, LoopOptions(effort="low", changed_files=["main.py"])
        )
    )
    assert record["status"] == "fail"
    # Two rounds without progress and the loop stops — far below the ceiling.
    assert fixer_calls <= 3
    assert any("ORDERS_DB" in e["message"] for e in record["targets"][0]["errors"])


def test_turned_off_for_the_task(project, monkeypatch):
    root, spec = project
    monkeypatch.setenv("WORKPILOT_VERIFY_LOOP", "false")
    record = asyncio.run(run_verify_loop(root, spec, None, LoopOptions()))
    assert record["status"] == "disabled"


def test_nothing_to_launch_is_not_applicable(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    (tmp_path / "lib.py").write_text("x = 1\n")
    record = asyncio.run(run_verify_loop(tmp_path, None, None, LoopOptions()))
    assert record["status"] == "not-applicable"
