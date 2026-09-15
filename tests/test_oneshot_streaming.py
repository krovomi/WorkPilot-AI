"""The delta protocol the one-shot runner speaks when a caller wants live output.

The Visual-to-Code page shows the files a generation produces *while* it runs,
and the only thing between the model and that panel is this protocol. What is
pinned here is the part a caller cannot recover from if it changes: one line
per chunk, JSON-encoded so a newline inside a chunk is not read as a chunk
boundary, and the existing ``__ONESHOT_RESULT__`` line still landing so a
caller that ignores the deltas sees exactly what it saw before.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

RUNNER = (
    Path(__file__).resolve().parents[1]
    / "apps"
    / "backend"
    / "runners"
    / "oneshot_completion_runner.py"
)


def load_runner():
    """Import the runner by path — it is a script, not an installed module."""
    spec = importlib.util.spec_from_file_location("oneshot_runner_undertest", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def runner():
    return load_runner()


def run(runner, monkeypatch, tmp_path, capsys, payload, chunks, result=None):
    """Drive the runner's main() with `core.oneshot` replaced by a fake."""
    seen = {}

    async def fake_completion(prompt, **kwargs):
        seen["on_delta"] = kwargs.get("on_delta")
        for chunk in chunks:
            if kwargs.get("on_delta"):
                kwargs["on_delta"](chunk)
        return result if result is not None else "".join(chunks)

    import types

    fake_module = types.ModuleType("core.oneshot")
    fake_module.oneshot_completion = fake_completion
    monkeypatch.setitem(sys.modules, "core.oneshot", fake_module)

    input_file = tmp_path / "input.json"
    input_file.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(sys, "argv", ["runner", "--input", str(input_file)])

    code = runner.main()
    return code, capsys.readouterr().out, seen


def deltas_in(stdout, runner):
    return [
        json.loads(line.split(runner.DELTA_MARKER, 1)[1])
        for line in stdout.splitlines()
        if runner.DELTA_MARKER in line
    ]


def test_each_chunk_is_one_line(runner, monkeypatch, tmp_path, capsys):
    chunks = ['{"files": [', '{"filename":"a.ts"}', "]}"]
    code, out, _ = run(
        runner, monkeypatch, tmp_path, capsys, {"prompt": "x", "stream": True}, chunks
    )

    assert code == 0
    assert deltas_in(out, runner) == chunks


def test_a_newline_inside_a_chunk_is_not_a_chunk_boundary(
    runner, monkeypatch, tmp_path, capsys
):
    # The reason chunks are JSON-encoded rather than printed raw: generated
    # code is mostly newlines, and a caller reading stdout line by line would
    # otherwise see one chunk as a dozen.
    chunks = ['{"content":"line1\nline2\nline3"}']
    _, out, _ = run(
        runner, monkeypatch, tmp_path, capsys, {"prompt": "x", "stream": True}, chunks
    )

    assert deltas_in(out, runner) == chunks


def test_the_result_marker_still_lands_when_streaming(
    runner, monkeypatch, tmp_path, capsys
):
    _, out, _ = run(
        runner,
        monkeypatch,
        tmp_path,
        capsys,
        {"prompt": "x", "stream": True},
        ["a", "b"],
        result="the whole answer",
    )

    assert runner.RESULT_MARKER + "the whole answer" in out


def test_nothing_streams_unless_the_caller_asked(runner, monkeypatch, tmp_path, capsys):
    # Every other caller of this runner (task title, terminal name, the spec
    # interview) reads stdout as it always did, and must keep seeing one line.
    code, out, seen = run(
        runner, monkeypatch, tmp_path, capsys, {"prompt": "x"}, ["a", "b"]
    )

    assert code == 0
    assert seen["on_delta"] is None
    assert runner.DELTA_MARKER not in out


def test_an_empty_chunk_is_not_announced(runner, monkeypatch, tmp_path, capsys):
    _, out, _ = run(
        runner,
        monkeypatch,
        tmp_path,
        capsys,
        {"prompt": "x", "stream": True},
        ["", "real", ""],
        result="real",
    )

    assert deltas_in(out, runner) == ["real"]
