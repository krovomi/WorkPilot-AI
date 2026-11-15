"""The base-vs-task comparison with its real observer, on the shop of `conftest.py`.

`tests/test_verify_compare.py` checks the bookkeeping with a stand-in
observer. Here both sides are launched for real: the base branch is checked
out next to the project, each side's API is started on its own port and the
verification's calls are made on both, so a feature the task added shows up
as a difference and nothing else does.
"""

from __future__ import annotations

import asyncio
import subprocess

from verify.compare import observe_side, run_base_comparison
from verify.loop import LoopOptions, run_verify_loop
from verify.record import load_record, save_record
from verify.state import work_dir

LIST_ROUTE = """

@app.get("/api/orders")
def list_orders():
    return list(ORDERS.values())
"""


def _git(repo, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout


def _task_adds_a_route(root) -> None:
    _git(root, "checkout", "-q", "-b", "task")
    main = root / "main.py"
    main.write_text(main.read_text(encoding="utf-8") + LIST_ROUTE, encoding="utf-8")
    _git(root, "commit", "-qam", "list the orders")


def _verify(root, spec) -> dict:
    record = asyncio.run(
        run_verify_loop(
            root, spec, None, LoopOptions(effort="low", changed_files=["main.py"])
        )
    )
    assert record["status"] == "pass", record["reason"]
    return record


def test_a_route_the_task_added_is_the_only_difference(shop):
    root, spec = shop
    _task_adds_a_route(root)
    record = _verify(root, spec)
    assert any(
        e["path"] == "/api/orders" and e["method"] == "GET" for e in record["endpoints"]
    )

    entry = asyncio.run(run_base_comparison(root, spec))

    assert entry["status"] == "done", entry
    assert entry["base"] == _git(root, "rev-parse", "main").strip()
    listed = [d for d in entry["differences"] if d["what"] == "GET /api/orders"]
    assert len(listed) == 1, entry["differences"]
    assert listed[0]["kind"] == "endpoint"
    assert listed[0]["task"] == "200" and listed[0]["base"] != "200"
    assert all(d["what"] != "GET /api/orders/1" for d in entry["differences"])
    assert load_record(spec / "verify")["compare"]["status"] == "done"
    # The base checkout is gone, and so are both apps.
    assert not (root / ".workpilot" / "verify-base" / spec.name).exists()
    assert "verify-base" not in _git(root, "worktree", "list")


def test_a_turned_off_verification_is_not_compared(shop, monkeypatch):
    root, spec = shop
    save_record(work_dir(root, spec), {"status": "pass", "endpoints": [{"path": "/"}]})
    monkeypatch.setenv("VERIFY_ENABLED", "false")
    entry = asyncio.run(run_base_comparison(root, spec))
    assert (entry["status"], entry["reason"]) == ("skipped", "verification turned off")


def test_a_spec_name_that_cannot_be_a_folder_is_refused(shop, tmp_path):
    root, _spec = shop
    _task_adds_a_route(root)
    odd = root / ".workpilot" / "specs" / "001 orders?"
    odd.mkdir(parents=True)
    save_record(work_dir(root, odd), {"status": "pass", "endpoints": [{"path": "/"}]})
    entry = asyncio.run(run_base_comparison(root, odd))
    assert entry["status"] == "skipped"
    assert entry["reason"] == "no place for the base checkout: unexpected spec name"


def test_a_base_that_cannot_be_checked_out_is_skipped(shop, monkeypatch):
    root, spec = shop
    _task_adds_a_route(root)
    save_record(work_dir(root, spec), {"status": "pass", "endpoints": [{"path": "/"}]})
    import verify.compare as compare_module

    real = compare_module._git_ok

    def no_worktree(cwd, *args, **kwargs):
        if args[:2] == ("worktree", "add"):
            return False
        return real(cwd, *args, **kwargs)

    monkeypatch.setattr(compare_module, "_git_ok", no_worktree)
    entry = asyncio.run(run_base_comparison(root, spec))
    assert entry["reason"] == "the base branch could not be checked out"


def test_one_side_without_its_api_or_a_browser(shop, tmp_path):
    root, spec = shop
    side = tmp_path / "side-spec"
    record = {
        "changed_files": ["main.py"],
        "endpoints": [
            {
                "method": "GET",
                "path": "/api/orders/1",
                "status": 200,
                "target": "fastapi",
            },
            {"method": "DELETE", "path": "/api/orders/1", "outcome": "skipped"},
        ],
        "scenario": [
            {"action": "navigate", "url": "http://127.0.0.1:1/orders"},
            {"action": "window_click", "automation_id": "Save"},
        ],
    }

    seen = asyncio.run(observe_side(root, side, record, tmp_path / "shot.png"))

    assert seen["endpoints"] == [
        {"method": "GET", "path": "/api/orders/1", "status": 200}
    ]
    assert "no browser to replay the scenario with" in seen["problems"]
    assert "the Windows app is no longer detected" in seen["problems"]
    assert "screenshot" not in seen

    # Without the API, a call is seen as failed rather than skipped.
    (root / "main.py").write_text("raise SystemExit(3)\n", encoding="utf-8")
    seen = asyncio.run(observe_side(root, side, record, tmp_path / "shot.png"))
    assert seen["endpoints"] == [
        {"method": "GET", "path": "/api/orders/1", "status": None}
    ]
    assert any("did not start" in p for p in seen["problems"])
