"""Replaying the verification on the base branch and on the task (prospective P8).

Each test pins a rule:

* what two launches of the same code print differently (a port, a query
  string, a bundler's hash, a line number) is not a difference;
* a difference says which side it is on: a step broken by the task is not a
  step the task fixed, and a pending request is never compared;
* the base side is the branch's merge base, checked out apart and removed
  after, without walking into a linked folder; the record's status is never
  changed by a comparison, and a second comparison replaces the first's
  captures;
* a comparison with nothing to replay, or no base to replay it on, says why;
* the route answers to `agent.execute` in server mode, like the run.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from verify.compare import (  # noqa: E402
    _checkout_dir,
    _remove_checkout,
    console_entries,
    diff_sides,
    network_entries,
    run_base_comparison,
)
from verify.record import load_record, new_record, save_record  # noqa: E402


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(  # noqa: S603 - fixed argv
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


class TestNormalisation:
    def test_console_drops_what_changes_between_launches(self):
        listing = "\n".join(
            [
                "## Console messages",
                "msgid=1 [error] Failed to load http://localhost:5173/api/x (1 args)",
                "msgid=2 [log] hello",
                "msgid=3 [warning] Deprecated at main.js:12:5",
                "msgid=4 [error] Failed to load http://127.0.0.1:4100/api/x",
            ]
        )
        assert console_entries(listing) == [
            "[error] Failed to load /api/x",
            "[warning] Deprecated at main.js",
        ]

    def test_network_keys_ignore_origin_query_and_hash(self):
        mcp = "reqid=1 GET http://localhost:5173/assets/index-B1x2y3z4.js?v=9 [success - 200]"
        playwright = "reqid=7 GET http://127.0.0.1:4173/assets/index-Zz9Yy8Xx.js [200]"
        assert (
            network_entries(mcp)
            == network_entries(playwright)
            == {"GET /assets/index-*.js": "200"}
        )
        assert network_entries(
            "reqid=2 POST https://api.example.com/v1/save [failed - net::ERR]"
        ) == {"POST https://api.example.com/v1/save": "failed"}
        assert network_entries("reqid=3 GET data:image/png;base64,xx [200]") == {}


class TestDiff:
    def test_each_difference_names_its_side(self):
        base = {
            "problems": ['click: button "Export" is no longer on the page'],
            "console": ["[error] old failure"],
            "network": {
                "GET /api/orders": "200",
                "GET /api/legacy": "200",
                "GET /x": "pending",
            },
            "endpoints": [{"method": "GET", "path": "/health", "status": 200}],
        }
        task = {
            "problems": ["confirmed state no longer shows: Saved"],
            "console": ["[error] TypeError: x is undefined"],
            "network": {
                "GET /api/orders": "500",
                "GET /api/export": "200",
                "GET /x": "404",
            },
            "endpoints": [{"method": "GET", "path": "/health", "status": 503}],
        }
        got = {(d["kind"], d["change"], d["what"]) for d in diff_sides(base, task)}
        assert got == {
            ("scenario", "broken", "confirmed state no longer shows: Saved"),
            ("scenario", "fixed", 'click: button "Export" is no longer on the page'),
            ("console", "added", "[error] TypeError: x is undefined"),
            ("console", "removed", "[error] old failure"),
            ("network", "changed", "GET /api/orders"),
            ("network", "added", "GET /api/export"),
            ("network", "removed", "GET /api/legacy"),
            ("endpoint", "changed", "GET /health"),
        }
        changed = next(
            d for d in diff_sides(base, task) if d["what"] == "GET /api/orders"
        )
        assert (changed["base"], changed["task"]) == ("200", "500")

    def test_same_behaviour_no_difference(self):
        side = {"problems": [], "console": ["[warning] w"], "network": {"GET /": "200"}}
        assert diff_sides(side, dict(side)) == []


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    _git(root, "init", "-q", "-b", "develop")
    (root / ".gitignore").write_text(".workpilot/\n", encoding="utf-8")
    (root / "app.txt").write_text("v1\n", encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-q", "-m", "base")
    _git(root, "checkout", "-q", "-b", "task")
    (root / "app.txt").write_text("v2\n", encoding="utf-8")
    _git(root, "commit", "-q", "-am", "task")
    spec = root / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    record = new_record(status="pass", finished_at=1.0)
    record["scenario"] = [{"action": "navigate", "url": "http://localhost:3000/"}]
    record["screenshots"] = [{"path": str(spec / "verify" / "a.png"), "label": "a"}]
    save_record(spec / "verify", record)
    return root, spec


def _fake_observe(calls: list):
    async def observe(
        code_dir: Path, side_spec: Path, record: dict, shot: Path
    ) -> dict:
        version = (code_dir / "app.txt").read_text(encoding="utf-8").strip()
        calls.append((code_dir, version, side_spec))
        shot.write_bytes(b"png")
        return {
            "problems": []
            if version == "v2"
            else ["confirmed state no longer shows: Saved"],
            "console": [],
            "network": {"GET /api/save": "404" if version == "v1" else "200"},
            "screenshot": str(shot),
        }

    return observe


class TestRun:
    def test_base_side_is_the_merge_base_checked_out_apart(self, repo):
        root, spec = repo
        calls: list = []
        entry = asyncio.run(
            run_base_comparison(root, spec, observe=_fake_observe(calls))
        )
        assert [c[1] for c in calls] == ["v1", "v2"]
        checkout = calls[0][0]
        assert checkout == root / ".workpilot" / "verify-base" / "001-x"
        assert not checkout.exists()
        assert len(_git(root, "worktree", "list").splitlines()) == 1
        assert calls[1][0] == root.resolve()
        # Each side has a folder of its own, without the card's scenario.
        assert calls[0][2] != calls[1][2]
        assert "verifyScenario" not in (calls[0][2] / "task_metadata.json").read_text(
            encoding="utf-8"
        )
        assert entry["status"] == "done"
        assert entry["base"] == _git(root, "rev-parse", "develop")
        changes = {(d["kind"], d["change"]) for d in entry["differences"]}
        assert changes == {("scenario", "fixed"), ("network", "changed")}

        record = load_record(spec / "verify")
        assert record["status"] == "pass"
        assert record["compare"]["screenshots"] == {"base": 1, "task": 2}
        assert [s.get("compare") for s in record["screenshots"]] == [
            None,
            "base",
            "task",
        ]

        asyncio.run(run_base_comparison(root, spec, observe=_fake_observe([])))
        record = load_record(spec / "verify")
        assert len(record["screenshots"]) == 3

    def test_nothing_to_replay_or_nowhere_to_replay_it(self, repo):
        root, spec = repo
        record = load_record(spec / "verify")
        record["scenario"] = []
        save_record(spec / "verify", record)
        entry = asyncio.run(run_base_comparison(root, spec, observe=_fake_observe([])))
        assert entry["status"] == "skipped" and "no scenario" in entry["reason"]

        record["scenario"] = [{"action": "navigate", "url": "/"}]
        record["status"] = "running"
        save_record(spec / "verify", record)
        entry = asyncio.run(run_base_comparison(root, spec, observe=_fake_observe([])))
        assert entry == {"status": "skipped", "reason": "nothing verified to compare"}

    def test_no_base_branch_is_said(self, tmp_path):
        root = tmp_path / "alone"
        root.mkdir()
        _git(root, "init", "-q", "-b", "trunk")
        (root / "f").write_text("x", encoding="utf-8")
        _git(root, "add", ".")
        _git(root, "commit", "-q", "-m", "one")
        spec = root / ".workpilot" / "specs" / "001-x"
        spec.mkdir(parents=True)
        record = new_record(status="fail", finished_at=1.0)
        record["endpoints"] = [{"method": "GET", "path": "/", "outcome": "called"}]
        save_record(spec / "verify", record)
        calls: list = []
        entry = asyncio.run(
            run_base_comparison(root, spec, observe=_fake_observe(calls))
        )
        assert entry["reason"] == "no base branch found" and calls == []


class TestCheckout:
    def test_refuses_an_odd_name_and_a_linked_folder(self, tmp_path):
        with pytest.raises(ValueError):
            _checkout_dir(tmp_path, "../escape")
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        (tmp_path / ".workpilot").symlink_to(elsewhere, target_is_directory=True)
        with pytest.raises(ValueError):
            _checkout_dir(tmp_path, "001-x")

    def test_removal_never_walks_into_a_linked_folder(self, tmp_path):
        project = tmp_path / "deps"
        (project / "node_modules").mkdir(parents=True)
        kept = project / "node_modules" / "kept.js"
        kept.write_text("x", encoding="utf-8")
        checkout = tmp_path / "checkout"
        checkout.mkdir()
        (checkout / "node_modules").symlink_to(
            project / "node_modules", target_is_directory=True
        )
        _remove_checkout(tmp_path, checkout, ["node_modules"])
        assert kept.is_file() and not checkout.exists()


class TestRoute:
    def test_compare_answers_to_agent_execute(self):
        from server.authz import mounting

        assert mounting.permission_for("POST", "/api/verify/compare", "verify") == (
            "agent.execute"
        )

    def test_compare_refuses_a_bad_address(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from verify.api import router

        app = FastAPI()
        app.include_router(router)
        body = TestClient(app).post("/api/verify/compare", json={"spec_id": "x"}).json()
        assert body["success"] is False
        assert json.dumps(body).find("Traceback") == -1
