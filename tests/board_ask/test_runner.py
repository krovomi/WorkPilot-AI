"""The board ask runner: input file in, one marker line out."""

from __future__ import annotations

import json

import pytest
from board_ask import semantic
from runners import board_ask_embed_runner as runner


def _write(tmp_path, payload) -> str:
    path = tmp_path / "input.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def _payload(tmp_path, **extra):
    return {
        "mode": "auto",
        "cache_dir": str(tmp_path / "cache"),
        "query": "admin",
        "documents": [{"id": "t1", "text": "admin"}, {"id": "t2", "text": "login"}],
        **extra,
    }


def _marker(out: str) -> dict:
    line = next(line for line in out.splitlines() if line.startswith(runner.MARKER))
    return json.loads(line[len(runner.MARKER) :])


def test_no_model_answers_a_null_source(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(semantic, "find", lambda: None)
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "claude")
    assert runner.main(["--input", _write(tmp_path, _payload(tmp_path))]) == 0
    assert _marker(capsys.readouterr().out) == {"source": None, "scores": []}


def test_a_ranking(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(semantic, "find", lambda: None)
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")
    vectors = {"admin": [1.0, 0.0], "login": [0.0, 1.0]}

    def post(url, payload, key, timeout):
        return {
            "data": [
                {"embedding": vectors[t], "index": i}
                for i, t in enumerate(payload["input"])
            ]
        }

    monkeypatch.setattr(semantic, "_post", post)
    assert runner.main(["--input", _write(tmp_path, _payload(tmp_path))]) == 0
    result = _marker(capsys.readouterr().out)
    assert result["source"]["provider"] == "openai"
    assert [s["id"] for s in result["scores"]] == ["t1", "t2"]
    assert (result["indexed"], result["total"]) == (2, 2)


def test_a_model_that_gives_no_vector_answers_a_null_source(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(semantic, "find", lambda: None)
    monkeypatch.setenv("SELECTED_LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0000")

    def down(*args):
        raise OSError("down")

    monkeypatch.setattr(semantic, "_post", down)
    assert runner.main(["--input", _write(tmp_path, _payload(tmp_path))]) == 0
    assert _marker(capsys.readouterr().out)["source"] is None


@pytest.mark.parametrize("bad", ["not json", json.dumps({"mode": "auto"})])
def test_a_malformed_input_exits_2_without_echoing_it(tmp_path, capsys, bad):
    path = tmp_path / "input.json"
    path.write_text(bad, encoding="utf-8")
    assert runner.main(["--input", str(path)]) == 2
    err = capsys.readouterr().err
    assert "invalid input" in err and "auto" not in err


def test_a_missing_or_huge_input_exits_2(tmp_path, monkeypatch):
    assert runner.main(["--input", str(tmp_path / "missing.json")]) == 2
    monkeypatch.setattr(runner, "MAX_INPUT_BYTES", 10)
    assert runner.main(["--input", _write(tmp_path, _payload(tmp_path))]) == 2


def test_the_runner_runs_as_the_app_starts_it(tmp_path):
    import os
    import subprocess
    import sys
    from pathlib import Path

    script = Path(runner.__file__)
    env = {k: v for k, v in os.environ.items() if not k.endswith("_API_KEY")}
    done = subprocess.run(
        [
            sys.executable,
            str(script),
            "--input",
            _write(tmp_path, _payload(tmp_path, mode="off")),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=60,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert _marker(done.stdout) == {"source": None, "scores": []}
