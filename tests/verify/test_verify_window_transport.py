"""`verify.window` off Windows: the helper's transport and the snapshot as text.

The helper is a small Python process speaking the same JSON lines as
`uia/driver.ps1`; each one misbehaves in one way a real helper can (dies
before its handshake, refuses to be ready, ignores the end of its input).
"""

from __future__ import annotations

import sys
import textwrap
import time

import pytest
from verify.window import (
    DriverError,
    HelperUnavailable,
    UiaDriver,
    format_snapshot,
)

HELPERS = {
    "dies": "import sys\nprint('starting up', flush=True)\nsys.exit(1)\n",
    "not-ready": "import json\nprint(json.dumps({'ready': False}), flush=True)\n",
    "list": "import json\nprint(json.dumps([1]), flush=True)\n",
    "garbled": "print('{not json', flush=True)\n",
    # Ready, then deaf to the end of its input.
    "stubborn": textwrap.dedent(
        """
        import json, time
        print(json.dumps({"ready": True}), flush=True)
        time.sleep(60)
        """
    ),
}


@pytest.fixture
def helper(tmp_path):
    drivers: list[UiaDriver] = []

    def make(mode: str, **kwargs) -> UiaDriver:
        script = tmp_path / f"{mode}.py"
        script.write_text(HELPERS[mode], encoding="utf-8")
        driver = UiaDriver([sys.executable, str(script)], env=None, **kwargs)
        drivers.append(driver)
        return driver

    yield make
    for driver in drivers:
        driver.close()


@pytest.mark.parametrize(
    ("mode", "message"),
    [
        (
            "dies",
            "the UI Automation helper did not start: the UI Automation helper stopped",
        ),
        ("not-ready", "the UI Automation helper did not start"),
        ("list", "the UI Automation helper did not start"),
        ("garbled", "the UI Automation helper did not start: "),
    ],
)
def test_a_helper_that_does_not_come_up_is_a_machine_limit(helper, mode, message):
    driver = helper(mode, start_timeout=10.0)
    with pytest.raises(HelperUnavailable) as caught:
        driver.request("ping")
    assert str(caught.value).startswith(message)
    assert driver._process is None


def test_a_helper_that_cannot_be_run_is_a_machine_limit(tmp_path):
    driver = UiaDriver([str(tmp_path / "no-such-helper.exe")], env=None)
    with pytest.raises(HelperUnavailable, match="could not start"):
        driver.request("ping")
    assert driver.available


def test_a_helper_deaf_to_its_input_is_killed_on_close(helper):
    driver = helper("stubborn", start_timeout=10.0, timeout=0.5)
    with pytest.raises(DriverError, match="did not answer"):
        driver.request("ping")
    assert driver._process is None
    started = time.monotonic()
    driver.close()  # nothing left to close
    assert time.monotonic() - started < 1


def test_the_snapshot_lists_each_elements_state():
    window = {"title": "Orders", "namedBy": "launch"}
    rows = [
        {"ref": "e1", "type": "Window", "name": "Orders", "depth": 0},
        {
            "ref": "e2",
            "type": "Button",
            "name": "Save",
            "automationId": "SaveButton",
            "depth": 1,
            "dialog": True,
            "enabled": False,
            "offscreen": True,
            "actions": ["invoke"],
        },
        {
            "ref": "e3",
            "type": "CheckBox",
            "value": "",
            "depth": 40,
            "toggle": "On",
            "selected": True,
            "expanded": "Collapsed",
        },
        {"type": "TreeItem", "expanded": "LeafNode"},
    ]
    text = format_snapshot(window, rows, truncated=True).splitlines()
    assert text[0] == 'Window "Orders" (main window of the launched app)'
    assert (
        '  e2 Button "Save" id=SaveButton [dialog, disabled, offscreen, can invoke]'
        in text
    )
    assert (
        "  " * 12 + 'e3 CheckBox value="" [toggle=On, selected, expand=Collapsed]'
        in text
    )
    assert "? TreeItem" in text
    assert (
        text[-1] == "(truncated: the window has more elements than one snapshot shows)"
    )
    named = format_snapshot({"title": "Login", "namedBy": "card"}, [], False)
    assert named.splitlines()[0] == 'Window "Login" (named by the card)'
