"""The `verify_*` tools every provider gets, through `VerifyToolbox.call`.

The project, the detection, the state file, the events, the captures filed
for visual QA and the endpoint calls are real. The browser is a stand-in that
answers in `BrowserSession`'s dialect (``uid=`` rows, ``MCP tool error``), so
each tool's own work is what is checked: which URL it accepts, what it writes
to the record, what it refuses. `tests/test_verify_browser.py` drives the
real browsers; the shop of `conftest.py` is launched for the endpoint tools.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import verify.tools as tools_module
from verify.perf import PerfResult
from verify.record import read_events
from verify.state import save_process
from verify.tools import (
    VerifyToolbox,
    close_toolboxes,
    execute_tool,
    is_verify_tool,
    tool_definitions,
    toolbox_for,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
SNAPSHOT = (
    'uid=1_0 RootWebArea "Orders"\n  uid=1_1 textbox "Email"\n  uid=1_2 button "Save"\n'
)


class StandInBrowser:
    """Answers like `BrowserSession`."""

    def __init__(self, available=True):
        self.available = available
        self.reasons = [] if available else ["no Chromium on this machine"]
        self.calls: list[tuple] = []
        self.kept: list[bool] = []
        self.closed = False
        self.shot_ok = True

    async def navigate(self, url):
        self.calls.append(("navigate", url))
        return f"Navigated to {url}"

    async def snapshot(self):
        return SNAPSHOT

    async def click(self, uid):
        self.calls.append(("click", uid))
        return "Clicked"

    async def fill(self, uid, value):
        self.calls.append(("fill", uid, value))
        return "Filled"

    async def press(self, key):
        self.calls.append(("press", key))
        return "Pressed"

    async def wait_for(self, texts, timeout_ms=10_000):
        return f"Found {texts[0]}"

    async def console(self):
        return "msgid=1 [error] boom"

    async def network(self):
        return "reqid=1 GET / [200]"

    async def emulate(self, viewport):
        return f"Emulating {viewport}"

    async def evaluate(self, script):
        return "42"

    async def screenshot(self, path, full_page=False):
        if not self.shot_ok:
            return False
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(PNG)
        return True

    async def perf_trace(self, url, trace_path):
        return PerfResult(url=url, lcp_ms=900.0, score=97, engine="stand-in")

    async def lighthouse(self):
        return {"accessibility": 100}

    async def save_trace(self, keep=True):
        self.kept.append(keep)
        return None

    async def save_video(self, keep=True):
        return None

    async def close(self):
        self.closed = True


@pytest.fixture
def web(tmp_path):
    """A Vite front end, its spec, and a toolbox with a stand-in browser."""
    root = tmp_path / "web"
    root.mkdir()
    (root / "package.json").write_text(
        json.dumps(
            {
                "name": "web",
                "scripts": {"dev": "vite"},
                "devDependencies": {"vite": "5"},
            }
        ),
        encoding="utf-8",
    )
    spec = root / ".workpilot" / "specs" / "001-save"
    spec.mkdir(parents=True)
    box = VerifyToolbox(root, spec, changed_files=["src/App.tsx"])
    box._browser = StandInBrowser()
    return box


def _run(box, name, **args):
    return asyncio.run(box.call(name, args))


def _launched(box, url="http://127.0.0.1:5173/"):
    save_process(box.base, "web", {"pid": 0, "url": url})


def test_the_tools_are_declared_once_for_every_provider():
    names = {t["name"] for t in tool_definitions()}
    assert {"verify_browser", "verify_record", "verify_launch"} <= names
    assert all(is_verify_tool(n) for n in names)
    assert not is_verify_tool("Bash")


def test_an_unknown_tool_and_a_failing_one_answer_instead_of_raising(web, monkeypatch):
    assert (
        _run(web, "verify_teleport") == "Error: unknown verify tool 'verify_teleport'"
    )

    def broken():
        raise OSError("disk gone")

    monkeypatch.setattr(web, "detection", broken)
    assert _run(web, "verify_detect") == "Error: disk gone"


def test_navigate_only_reaches_the_launched_app(web):
    assert _run(web, "verify_browser", action="navigate", url="/orders").startswith(
        "Error: navigate needs"
    )
    _launched(web)
    assert _run(web, "verify_browser", action="navigate", url="/orders") == (
        "Navigated to http://127.0.0.1:5173/orders"
    )
    assert _run(
        web, "verify_browser", action="navigate", url="http://localhost:3000/x"
    ).endswith("localhost:3000/x")
    assert _run(
        web, "verify_browser", action="navigate", url="https://example.com/"
    ).startswith("Error: ")
    # No URL: where the browser already is.
    assert _run(web, "verify_browser", action="navigate") == (
        "Navigated to http://localhost:3000/x"
    )
    steps = [e for e in read_events(web.base) if e["kind"] == "step"]
    assert [s["url"] for s in steps] == [
        "http://127.0.0.1:5173/orders",
        "http://localhost:3000/x",
        "http://localhost:3000/x",
    ]


def test_a_click_is_recorded_with_what_the_row_said(web):
    _launched(web)
    _run(web, "verify_browser", action="snapshot")
    _run(web, "verify_browser", action="fill", uid="1_1", value="a@b.c")
    _run(web, "verify_browser", action="click", uid="1_2")
    _run(web, "verify_browser", action="press")
    assert (
        _run(web, "verify_browser", action="wait_for") == "Error: wait_for needs text"
    )
    _run(web, "verify_browser", action="wait_for", text="Saved")

    steps = [
        {k: v for k, v in e.items() if k not in ("kind", "at")}
        for e in read_events(web.base)
        if e["kind"] == "step"
    ]
    assert steps == [
        {"action": "fill", "uid": "1_1", "value": "a@b.c", "text": 'textbox "Email"'},
        {"action": "click", "uid": "1_2", "text": 'button "Save"'},
        {"action": "press", "value": "Enter"},
        {"action": "wait_for", "value": "Saved"},
    ]


def test_the_read_only_browser_actions(web):
    assert _run(web, "verify_browser", action="console") == "msgid=1 [error] boom"
    assert _run(web, "verify_browser", action="network").startswith("reqid=1")
    assert _run(web, "verify_browser", action="emulate") == "Emulating mobile"
    assert (
        _run(web, "verify_browser", action="evaluate") == "Error: evaluate needs script"
    )
    assert _run(web, "verify_browser", action="evaluate", script="() => 42") == "42"
    assert (
        _run(web, "verify_browser", action="fly")
        == "Error: unknown browser action 'fly'"
    )


def test_without_a_browser_every_page_tool_says_why(web):
    web._browser = StandInBrowser(available=False)
    for name, args in (
        ("verify_browser", {"action": "snapshot"}),
        ("verify_screenshot", {}),
        ("verify_perf_trace", {}),
    ):
        assert _run(web, name, **args) == (
            "Error: no browser could start — no Chromium on this machine"
        )


def test_a_screenshot_is_kept_and_filed_for_visual_review(web):
    _launched(web)
    answer = json.loads(
        _run(web, "verify_screenshot", url="/orders", label="Orders: saved!")
    )
    assert Path(answer["path"]).name == "orders-saved.png"
    assert answer["filed_for_visual_review"] is True
    [event] = [e for e in read_events(web.base) if e["kind"] == "screenshot"]
    assert event["url"] == "http://127.0.0.1:5173/orders"
    assert event["platform"] == "web"
    assert _run(web, "verify_screenshot", url="https://example.com") == (
        "Error: a loopback URL or a path is expected"
    )
    web._browser.shot_ok = False
    assert _run(web, "verify_screenshot") == "Error: the screenshot could not be taken"


def test_a_screenshot_without_a_spec_is_not_filed(tmp_path):
    box = VerifyToolbox(tmp_path)
    box._browser = StandInBrowser()
    answer = json.loads(asyncio.run(box.call("verify_screenshot", {})))
    assert answer["filed_for_visual_review"] is False
    assert Path(answer["path"]).name == "screenshot.png"


def test_a_perf_trace_needs_a_page_and_can_be_turned_off(web, monkeypatch):
    assert _run(web, "verify_perf_trace").startswith("Error: no page to trace")
    _launched(web)
    data = json.loads(_run(web, "verify_perf_trace", url="/"))
    assert data["lcp_ms"] == 900.0 and data["lighthouse"] == {"accessibility": 100}
    assert [e["score"] for e in read_events(web.base) if e["kind"] == "perf"] == [97]

    monkeypatch.setenv("VERIFY_PERF_TRACE", "false")
    off = VerifyToolbox(web.project_dir, web.spec_dir)
    assert _run(off, "verify_perf_trace").startswith(
        "Performance tracing is turned off"
    )


def test_record_takes_known_kinds_and_saves_the_trace_on_a_verdict(web):
    assert _run(web, "verify_record", kind="guess").startswith("Error: kind must be")
    _launched(web)
    _run(web, "verify_browser", action="navigate", url="/orders")
    assert _run(
        web, "verify_record", kind="confirm", state="saved", evidence="x" * 3000
    ) == ("Recorded (confirm).")
    assert (
        _run(web, "verify_record", kind="verdict", verdict="pass")
        == "Recorded (verdict)."
    )
    confirm = next(e for e in read_events(web.base) if e["kind"] == "confirm")
    assert confirm["url"] == "http://127.0.0.1:5173/orders"
    assert len(confirm["evidence"]) == 2000
    # No scenario step was reported through this toolbox: its trace is not kept.
    assert web._browser.kept == [False]


def test_scenario_steps_follow_the_card(web):
    assert _run(web, "verify_record", kind="scenario_step", step=1).startswith(
        "Error: this card has no scenario"
    )
    (web.spec_dir / "task_metadata.json").write_text(
        json.dumps({"verifyScenario": "1. Open the orders page\n2. Click Save"}),
        encoding="utf-8",
    )
    record = "verify_record"
    assert _run(web, record, kind="scenario_step", step=3, outcome="pass") == (
        "Error: step must be a number from 1 to 2"
    )
    assert _run(web, record, kind="scenario_step", step="one").startswith("Error: step")
    assert _run(web, record, kind="scenario_step", step=1, outcome="maybe") == (
        "Error: outcome must be pass, fail or blocked"
    )
    shot = web.base / "screenshots" / "orders.png"
    shot.parent.mkdir(parents=True, exist_ok=True)
    shot.write_bytes(PNG)
    elsewhere = web.project_dir / "secret.png"
    elsewhere.write_bytes(PNG)
    assert (
        _run(
            web,
            record,
            kind="scenario_step",
            step=1,
            outcome="pass",
            screenshot=str(shot),
        )
        == "Recorded step 1 of 2 (pass)."
    )
    _run(
        web,
        record,
        kind="scenario_step",
        step=2,
        outcome="fail",
        screenshot=str(elsewhere),
    )
    steps = [e for e in read_events(web.base) if e["kind"] == "scenario_step"]
    assert steps[0]["screenshot"] == str(shot.resolve())
    assert "screenshot" not in steps[1]  # a model never names another file
    asyncio.run(web.save_trace())
    assert web._browser.kept == [True]


def test_logs_and_stop(web):
    assert _run(web, "verify_logs", target="nothing") == "Error: no target"
    log = web.base / "logs" / "web.log"
    log.parent.mkdir(parents=True)
    log.write_text("ready\nTypeError: x is undefined\n", encoding="utf-8")
    data = json.loads(_run(web, "verify_logs"))
    assert data["target"] == "web"
    assert data["errors"][0]["kind"] == "exception"
    assert data["log_tail"].endswith("x is undefined\n")

    assert _run(web, "verify_stop", target="nothing") == "Error: no such target"
    assert json.loads(_run(web, "verify_stop", target="web")) == {"stopped": []}
    _launched(web)
    assert json.loads(_run(web, "verify_stop", target="web")) == {"stopped": ["web"]}
    _launched(web)
    assert json.loads(_run(web, "verify_stop")) == {"stopped": ["web"]}


def test_launch_and_api_tools_need_their_target(web):
    assert _run(web, "verify_endpoints") == "Error: no API target in this project"
    assert _run(web, "verify_call_endpoint").startswith("Error: the API is not running")
    assert _run(web, "verify_window", action="snapshot").startswith(
        "Error: no Windows app"
    )
    empty = VerifyToolbox(web.project_dir / "src")
    assert _run(empty, "verify_launch").startswith("Error: no launchable target")
    assert _run(empty, "verify_call_endpoint") == "Error: no API target"


def test_the_endpoint_tools_on_a_launched_api(shop):
    root, spec = shop
    box = VerifyToolbox(root, spec, changed_files=["main.py"])
    try:
        assert _run(box, "verify_endpoints").startswith("Error: the API is not running")
        launched = json.loads(_run(box, "verify_launch"))
        assert launched["status"] == "ready", launched

        prepared = json.loads(_run(box, "verify_endpoints"))
        assert prepared["total_operations"] == 2
        assert {c["call"]["path"] for c in prepared["calls"]} >= {"/api/orders"}
        everything = json.loads(_run(box, "verify_endpoints", all=True))
        assert everything["touched"] is None

        created = json.loads(
            _run(
                box,
                "verify_call_endpoint",
                method="post",
                path="/api/orders",
                body={"email": "x@y.z", "quantity": 1},
            )
        )
        # The documented success status is expected when none is named.
        assert (created["status"], created["ok"]) == (201, True)
        missing = json.loads(
            _run(
                box, "verify_call_endpoint", path="/api/orders/99", expect_status="404"
            )
        )
        assert (missing["status"], missing["ok"]) == (404, True)
        listed = json.loads(
            _run(
                box,
                "verify_call_endpoint",
                path="/api/orders/1",
                expect_status=[200, "x"],
            )
        )
        assert listed["ok"] is True and listed["target"] == "fastapi"

        logs = json.loads(_run(box, "verify_logs"))
        assert logs["errors"] == []
    finally:
        _run(box, "verify_stop")


def test_an_api_without_an_openapi_document_says_what_to_do(tmp_path):
    import http.server
    import threading

    class NoDocs(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server's name
            self.send_response(404)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), NoDocs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        (tmp_path / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
        (tmp_path / "main.py").write_text("app = None\n", encoding="utf-8")
        box = VerifyToolbox(tmp_path, changed_files=["main.py"])
        api = box.target(None, ("backend-api",))
        save_process(
            box.base,
            api.name,
            {"pid": 0, "url": f"http://127.0.0.1:{server.server_port}"},
        )
        answer = json.loads(_run(box, "verify_endpoints"))
        assert answer["openapi"] is None
        assert "publishes no OpenAPI document" in answer["note"]
    finally:
        server.shutdown()


def test_the_device_tool_lists_and_launches(web, monkeypatch):
    import mobile.devices as devices_module
    import verify.mobile as verify_mobile_module
    from mobile.devices import DeviceListing

    monkeypatch.setattr(
        devices_module,
        "list_devices",
        lambda platforms=None: DeviceListing((), {"android": "adb is not on the PATH"}),
    )
    assert json.loads(_run(web, "verify_device")) == {
        "devices": [],
        "unavailable": {"android": "adb is not on the PATH"},
    }

    seen = {}

    def verify_mobile(project, spec, base, platforms, *, build):
        seen.update(platforms=platforms, build=build)
        frame = base / "frames" / "android.png"
        return [
            verify_mobile_module.PlatformVerification(
                "android", "verified", frame=str(frame)
            )
        ]

    monkeypatch.setattr(verify_mobile_module, "verify_mobile", verify_mobile)
    [result] = json.loads(
        _run(web, "verify_device", action="launch", platform="android")
    )
    assert result["status"] == "verified"
    assert seen == {"platforms": ["android"], "build": True}
    [shot] = [e for e in read_events(web.base) if e["kind"] == "screenshot"]
    assert shot["label"] == "android: app launched"
    _run(web, "verify_device", action="frame")
    assert seen == {"platforms": None, "build": False}


def test_one_toolbox_per_project_and_event_loop(tmp_path):
    first = toolbox_for(tmp_path)
    assert toolbox_for(tmp_path) is first

    async def inside():
        return toolbox_for(tmp_path, tmp_path / "spec")

    assert asyncio.run(inside()) is not first
    answer = asyncio.run(execute_tool("verify_detect", {}, project_dir=tmp_path))
    assert json.loads(answer)["applicable"] is False

    browser = StandInBrowser()
    first._browser = browser
    asyncio.run(close_toolboxes(tmp_path))
    assert browser.closed and browser.kept == [False]
    assert toolbox_for(tmp_path) is not first
    asyncio.run(close_toolboxes())
    assert tools_module._TOOLBOXES == {}


def test_changed_files_come_from_git_when_the_caller_has_none(shop, monkeypatch):
    root, _spec = shop
    (root / "orders.py").write_text("x = 1\n", encoding="utf-8")
    box = VerifyToolbox(root)
    assert box._changed_files() == ["orders.py"]

    import verify.git as git_module

    def broken(project):
        raise OSError("git vanished")

    monkeypatch.setattr(git_module, "changed_files", broken)
    assert VerifyToolbox(root)._changed_files() == []
