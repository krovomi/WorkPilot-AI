"""`verify-replay`: the verification played again after QA, without a model.

The end-to-end cases launch the real shop of `conftest.py`, verify it, change
its code the way QA would and replay: the endpoint calls are made again on a
fresh port and a broken one turns the record to ``fail``. The scenario half
needs a page or a Windows window; it is driven here through stand-ins that
answer like `BrowserSession` and `WindowSession` (snapshot rows, ``MCP tool
error`` answers), so what is checked is how a recorded step finds its element
again — by its description, not by a uid that does not survive a reload.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from types import SimpleNamespace

from verify.git import fingerprint
from verify.loop import LoopOptions, run_verify_loop
from verify.record import load_record, save_record
from verify.replay import (
    _uid_for,
    _window_ref,
    replay_scenario,
    run_replay,
    run_replay_phase,
)
from verify.state import work_dir
from verify.target import Target
from verify.window import DriverError


def git(repo, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout


def _verify(root, spec) -> dict:
    async def runner(agent_type, prompt):  # pragma: no cover - low effort calls none
        raise AssertionError(f"no session at low effort, got {agent_type}")

    record = asyncio.run(
        run_verify_loop(
            root, spec, runner, LoopOptions(effort="low", changed_files=["main.py"])
        )
    )
    assert record["status"] == "pass", record["reason"]
    return record


def test_nothing_changed_since_the_verification_is_not_replayed(shop):
    root, spec = shop
    _verify(root, spec)

    replay = asyncio.run(run_replay(root, spec))

    assert replay["status"] == "skipped"
    assert replay["reason"] == "no change since the verification"
    assert load_record(spec / "verify")["replay"]["status"] == "skipped"


def test_a_harmless_qa_change_still_holds(shop):
    root, spec = shop
    _verify(root, spec)
    main = root / "main.py"
    main.write_text(
        "# QA: a comment\n" + main.read_text(encoding="utf-8"), encoding="utf-8"
    )

    replay = asyncio.run(run_replay(root, spec))

    assert replay["status"] == "pass", replay["problems"]
    record = load_record(spec / "verify")
    assert record["status"] == "pass"
    assert record["fingerprint"] == fingerprint(root)
    assert record["head"] == git(root, "rev-parse", "HEAD").strip()


def test_a_qa_fix_that_breaks_an_endpoint_regresses_the_record(shop):
    root, spec = shop
    _verify(root, spec)
    main = root / "main.py"
    main.write_text(
        main.read_text(encoding="utf-8").replace(
            "    return ORDERS[order_id]", "    raise RuntimeError('QA broke it')"
        ),
        encoding="utf-8",
    )
    git(root, "commit", "-qam", "qa fix")

    replay = asyncio.run(run_replay(root, spec))

    assert replay["status"] == "fail"
    assert any(p.startswith("GET /api/orders/1: 500") for p in replay["problems"])
    record = load_record(spec / "verify")
    assert record["status"] == "fail"
    assert record["reason"].startswith("regressed after QA: ")
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    assert plan["verification"]["status"] == "fail"
    # Nothing is left running after a replay.
    assert (
        json.loads((spec / "verify" / "state.json").read_text(encoding="utf-8"))[
            "processes"
        ]
        == {}
    )


def test_an_app_that_no_longer_starts_is_a_regression(shop):
    root, spec = shop
    _verify(root, spec)
    (root / "main.py").write_text(
        "raise SystemExit('settings: SHOP_DB is not configured')\n", encoding="utf-8"
    )

    replay = asyncio.run(run_replay(root, spec))

    assert replay["status"] == "fail"
    assert any("did not start" in p for p in replay["problems"]), replay["problems"]
    # The endpoints cannot be called without the API.
    assert "the API did not start for the replay" in replay["problems"]


def test_no_record_and_a_turned_off_verification_are_skipped(shop, monkeypatch):
    root, spec = shop
    assert asyncio.run(run_replay(root, spec)) == {
        "status": "skipped",
        "reason": "nothing verified to replay",
    }
    save_record(work_dir(root, spec), {"status": "pass"})
    monkeypatch.setenv("VERIFY_ENABLED", "false")
    assert asyncio.run(run_replay(root, spec))["reason"] == "verification turned off"


# -- the phase -------------------------------------------------------------


def _phase_args(root, spec):
    resolved = SimpleNamespace(
        phase=SimpleNamespace(id="verify-replay", impl="verify-replay"),
        dispatch="inline",
    )
    return resolved, SimpleNamespace(project_dir=root, spec_dir=spec)


def test_the_phase_reports_each_answer(shop, monkeypatch):
    root, spec = shop
    resolved, ctx = _phase_args(root, spec)

    skipped = asyncio.run(run_replay_phase(resolved, ctx))
    assert skipped.succeeded is None
    assert skipped.detail == "nothing verified to replay"

    import verify.replay as replay_module

    async def answer(status, problems=()):
        return {"status": status, "problems": list(problems)}

    monkeypatch.setattr(replay_module, "run_replay", lambda *_: answer("pass"))
    held = asyncio.run(run_replay_phase(resolved, ctx))
    assert (held.succeeded, held.detail) == (True, "the verification still holds")

    monkeypatch.setattr(
        replay_module, "run_replay", lambda *_: answer("fail", ["a", "b"])
    )
    failed = asyncio.run(run_replay_phase(resolved, ctx))
    assert (failed.succeeded, failed.detail) == (False, "a; b")

    async def boom(*_):
        raise RuntimeError("git vanished")

    monkeypatch.setattr(replay_module, "run_replay", boom)
    crashed = asyncio.run(run_replay_phase(resolved, ctx))
    assert (crashed.succeeded, crashed.detail) == (None, "git vanished")


# -- finding an element again ----------------------------------------------


SNAPSHOT = """uid=1_0 RootWebArea "Orders"
  uid=1_1 heading "Orders" level="1"
  uid=1_2 textbox "Email" value="a@b.c"
  uid=1_3 button "Save"
"""


def test_a_step_finds_its_element_by_what_the_row_said():
    assert _uid_for(SNAPSHOT, 'button   "Save"') == "1_3"
    # The row gained or lost a value: its role and name still identify it.
    assert _uid_for(SNAPSHOT, 'textbox "Email" value=""') == "1_2"
    assert _uid_for(SNAPSHOT, 'button "Delete"') == ""
    assert _uid_for(SNAPSHOT, "") == ""
    assert _uid_for(SNAPSHOT, "Save") == ""


def test_a_window_step_finds_its_element_by_automation_id_then_by_name():
    rows = [
        {"ref": "e1", "type": "Button", "name": "Save", "automationId": "SaveButton"},
        {"ref": "e2", "type": "Edit", "name": "Email", "automationId": ""},
    ]
    assert _window_ref(rows, {"automation_id": "SaveButton"}) == "e1"
    assert _window_ref(rows, {"automation_id": "Gone"}) == ""
    assert _window_ref(rows, {"text": 'Edit "Email"'}) == "e2"
    assert _window_ref(rows, {"text": 'Edit "Name"'}) == ""
    assert _window_ref(rows, {}) == ""


class FakeBrowser:
    """Answers like `BrowserSession`: text, ``MCP tool error`` on a miss."""

    def __init__(self, snapshot=SNAPSHOT, page="", available=True):
        self.available = available
        self.page = page
        self._snapshot = snapshot
        self.calls: list[tuple] = []

    async def navigate(self, url):
        self.calls.append(("navigate", url))
        return "Failed: net::ERR" if url.endswith("/gone") else f"Navigated to {url}"

    async def snapshot(self):
        return self._snapshot

    async def click(self, uid):
        self.calls.append(("click", uid))
        return "MCP tool error: detached" if uid == "1_1" else "clicked"

    async def fill(self, uid, value):
        self.calls.append(("fill", uid, value))
        return "filled"

    async def press(self, key):
        self.calls.append(("press", key))
        return "pressed"

    async def wait_for(self, texts, timeout_ms=5000):
        self.calls.append(("wait_for", texts[0]))
        if texts[0] in self.page:
            return "Element found"
        return "MCP tool error: timeout"


class FakeToolbox:
    def __init__(self, browser=None, targets=(), window=None, url=""):
        self._browser = browser
        self._targets = {t.kind: t for t in targets}
        self._window = window
        self._url = url

    def target(self, wanted, kinds=()):
        for kind in kinds:
            if kind in self._targets:
                return self._targets[kind]
        return None

    async def browser(self, target):
        return self._browser

    def url_of(self, target):
        return self._url

    def window(self, target):
        return self._window


WEB = Target(name="web", kind="web-frontend", root=".", command="npm run dev")


def test_the_scenario_is_replayed_on_the_new_origin():
    browser = FakeBrowser(page="Saved! order 2")
    record = {
        "scenario": [
            {"action": "navigate", "url": "http://127.0.0.1:5173/orders"},
            {"action": "fill", "text": 'textbox "Email"', "value": "x@y.z"},
            {"action": "click", "text": 'button "Save"'},
            {"action": "press"},
            {"action": "wait_for", "value": "Saved!"},
        ],
        "confirmations": [
            {"evidence": "order 2"},
            {"evidence": "multi\nline evidence is not looked for"},
            {"evidence": ""},
        ],
    }
    toolbox = FakeToolbox(browser, [WEB], url="http://127.0.0.1:4100")

    assert asyncio.run(replay_scenario(toolbox, record)) == []
    assert browser.calls == [
        ("navigate", "http://127.0.0.1:4100/orders"),
        ("fill", "1_2", "x@y.z"),
        ("click", "1_3"),
        ("press", "Enter"),
        ("wait_for", "Saved!"),
        ("wait_for", "order 2"),
    ]


def test_each_way_a_scenario_step_can_fail_is_named():
    browser = FakeBrowser(page="")
    record = {
        "scenario": [
            {"action": "navigate", "url": "http://localhost:3000/gone"},
            {"action": "click", "text": 'button "Delete"'},
            {"action": "click", "text": 'heading "Orders" level="1"'},
            {"action": "wait_for", "value": "Saved!"},
        ],
        "confirmations": [{"evidence": "order 2"}],
    }
    # No URL for the target: the recorded one is used as it was.
    problems = asyncio.run(replay_scenario(FakeToolbox(browser, [WEB]), record))

    assert browser.calls[0] == ("navigate", "http://localhost:3000/gone")
    assert problems == [
        "navigate /gone: Failed: net::ERR",
        'click: button "Delete" is no longer on the page',
        'click heading "Orders" level="1": MCP tool error: detached',
        "'Saved!' never appeared",
        "confirmed state no longer shows: order 2",
    ]


def test_a_scenario_without_a_browser_says_so():
    record = {"scenario": [{"action": "navigate", "url": "/"}]}
    toolbox = FakeToolbox(FakeBrowser(available=False), [WEB])
    assert asyncio.run(replay_scenario(toolbox, record)) == [
        "no browser to replay the scenario with"
    ]
    assert asyncio.run(replay_scenario(toolbox, {})) == []


class FakeWindow:
    """Answers like `WindowSession`: rows with refs, a bool for wait_for."""

    def __init__(self, rows, texts=(), fail_on=None):
        self.rows = rows
        self.texts = set(texts)
        self.fail_on = fail_on
        self.acted: list[tuple] = []

    def wait_for(self, value, timeout=10.0):
        return value in self.texts

    def snapshot(self):
        return {"title": "Orders"}, self.rows, False

    def act(self, action, ref, value=""):
        if action == self.fail_on:
            raise DriverError("the window closed")
        self.acted.append((action, ref, value))


DESKTOP = Target(name="Orders", kind="windows-app", root=".", command="dotnet run")
ROWS = [
    {"ref": "e1", "type": "Edit", "name": "Email", "automationId": "Email"},
    {"ref": "e2", "type": "Button", "name": "Save", "automationId": "Save"},
]


def test_a_windows_scenario_is_replayed_in_its_window():
    window = FakeWindow(ROWS, texts={"Saved", "order 2"})
    record = {
        "scenario": [
            {"action": "window_fill", "automation_id": "Email", "value": "x@y.z"},
            {"action": "window_click", "automation_id": "Save"},
            {"action": "window_wait_for", "value": "Saved"},
        ],
        "confirmations": [{"evidence": "order 2"}],
    }
    toolbox = FakeToolbox(targets=[DESKTOP], window=window)

    assert asyncio.run(replay_scenario(toolbox, record)) == []
    assert window.acted == [("fill", "e1", "x@y.z"), ("click", "e2", "")]


def test_a_windows_scenario_names_what_went_missing():
    window = FakeWindow(ROWS, texts=set())
    record = {
        "scenario": [
            {"action": "window_click", "automation_id": "Delete", "text": "Delete"},
            {"action": "window_wait_for", "value": "Saved"},
        ],
        "confirmations": [{"evidence": "order 2"}],
    }
    problems = asyncio.run(
        replay_scenario(FakeToolbox(targets=[DESKTOP], window=window), record)
    )
    assert problems == [
        "click: Delete is no longer in the window",
        "'Saved' never appeared in the window",
        "confirmed state no longer shows: order 2",
    ]


def test_a_windows_app_that_closes_or_vanished_is_a_problem():
    record = {"scenario": [{"action": "window_click", "automation_id": "Save"}]}
    closing = FakeWindow(ROWS, fail_on="click")
    assert asyncio.run(
        replay_scenario(FakeToolbox(targets=[DESKTOP], window=closing), record)
    ) == ["Orders: the window closed"]
    assert asyncio.run(replay_scenario(FakeToolbox(), record)) == [
        "the Windows app is no longer detected"
    ]


def test_a_mixed_scenario_looks_for_the_confirmed_state_on_the_page():
    window = FakeWindow(ROWS, texts=set())
    browser = FakeBrowser(page="order 2")
    record = {
        "scenario": [
            {"action": "window_click", "automation_id": "Save"},
            {"action": "navigate", "url": "/orders"},
        ],
        "confirmations": [{"evidence": "order 2"}],
    }
    toolbox = FakeToolbox(browser, [WEB, DESKTOP], window=window, url="http://h:1")
    # The window is not asked for the confirmation; the page shows it.
    assert asyncio.run(replay_scenario(toolbox, record)) == []
    assert ("wait_for", "order 2") in browser.calls


def test_a_mixed_scenario_without_a_browser_keeps_what_the_window_found():
    record = {
        "scenario": [
            {"action": "window_click", "automation_id": "Delete", "text": "Delete"},
            {"action": "navigate", "url": "/orders"},
        ],
    }
    toolbox = FakeToolbox(
        FakeBrowser(available=False), [WEB, DESKTOP], window=FakeWindow(ROWS)
    )
    assert asyncio.run(replay_scenario(toolbox, record)) == [
        "click: Delete is no longer in the window",
        "no browser to replay the scenario with",
    ]
