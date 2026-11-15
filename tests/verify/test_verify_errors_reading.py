"""`verify.errors` on the logs that test its edges: repeats, floods, huge traces.

The fix loop is bounded by whether the error count falls, so a repeated
error must count once, a located copy must win over a bare one, and a flood
must stop at the cap rather than make every round look like progress.
"""

from __future__ import annotations

import sys

import verify.errors as errors_module
from verify.errors import (
    MAX_ERRORS,
    VerifyError,
    collect_errors,
    dedupe,
    network_errors,
)


def test_the_located_copy_of_an_error_wins():
    bare = VerifyError("exception", "KeyError: 'total'", source="log")
    located = VerifyError("exception", "KeyError: 'total'", file="main.py", line=12)
    other_bare = VerifyError("exception", "KeyError: 'total'")
    assert dedupe([bare, located, other_bare]) == [located]
    # A located one already kept is not replaced by a bare one.
    assert dedupe([located, bare]) == [located]


def test_numbers_and_addresses_do_not_make_an_error_new():
    out = dedupe(
        [
            VerifyError("crash", "segfault at 0x7ffe12 in worker 1234"),
            VerifyError("crash", "segfault at 0xdeadbeef in worker  5678"),
        ]
    )
    assert len(out) == 1


def test_a_flood_of_errors_stops_at_the_cap():
    log = "\n".join(
        f"ValueError: row {chr(65 + i % 26)}{chr(97 + i // 26)} is bad"
        for i in range(80)
    )
    found = collect_errors(log)
    assert len(found) == MAX_ERRORS
    assert all(e.kind == "exception" for e in found)


def test_a_huge_trace_is_read_from_its_end(tmp_path):
    (tmp_path / "app.py").write_text("x = 1\n", encoding="utf-8")
    noise = "".join(
        f'  File "/usr/lib/python3.12/x{i}.py", line 1, in f\n' for i in range(2000)
    )
    log = (
        "Traceback (most recent call last):\n"
        + noise
        + f'  File "{tmp_path / "app.py"}", line 1, in <module>\n'
        + "RuntimeError: the end of a long trace\n"
    )
    assert len(log) > 60_000
    found = collect_errors(log, tmp_path)
    assert any("the end of a long trace" in e.message for e in found)


def test_without_its_optional_readers_the_log_is_still_read(monkeypatch):
    # The trace reader cannot be imported, and the build parser breaks.
    monkeypatch.setitem(sys.modules, "docintel.stacktrace", None)

    def broken(text):
        raise RuntimeError("parser bug")

    monkeypatch.setattr(errors_module, "parse_build_errors", broken)
    found = collect_errors("panic: runtime error: index out of range\n")
    assert [(e.kind, e.message) for e in found] == [
        ("crash", "panic: runtime error: index out of range")
    ]


def test_network_lines_that_are_not_requests_are_skipped():
    text = "\n".join(
        [
            "## Network requests",
            "reqid=1 GET http://127.0.0.1:5173/assets/app.js [404]",
            "reqid=2 GET http://127.0.0.1:5173/favicon.ico [404]",
            "reqid=3 GET http://127.0.0.1:5173/api/orders/9 [404]",
            "reqid=4 POST http://127.0.0.1:5173/graphql [failed - net::ERR_CONNECTION_REFUSED]",
            "something else entirely",
        ]
    )
    assert [e.message for e in network_errors(text)] == [
        "GET http://127.0.0.1:5173/assets/app.js -> 404",
        "POST http://127.0.0.1:5173/graphql -> net::ERR_CONNECTION_REFUSED",
    ]
    assert network_errors("") == []
