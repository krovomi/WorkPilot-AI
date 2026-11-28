"""The board-ask runner of the server: the clone in, one marker line out."""

from __future__ import annotations

import json

import pytest
from runners import board_ask_runner as runner


def _clone(tmp_path):
    card = tmp_path / ".workpilot" / "specs" / "001-admin"
    card.mkdir(parents=True)
    (card / "implementation_plan.json").write_text(
        json.dumps({"feature": "Admin page", "status": "done"}), encoding="utf-8"
    )
    return tmp_path


def test_the_history_is_read_bounded(tmp_path):
    path = tmp_path / "history.json"
    turns = [
        {"question": "q" * 5000, "answer": "a"},
        {"question": 1, "answer": "x"},
        "junk",
    ]
    path.write_text(json.dumps(turns * 3), encoding="utf-8")
    history = runner.read_history(str(path))
    assert len(history) == 3
    assert history[0] == {"question": "q" * runner.TURN_CHARS, "answer": "a"}
    assert runner.read_history(None) == []
    assert runner.read_history(str(tmp_path / "missing.json")) == []
    path.write_text('{"not": "a list"}', encoding="utf-8")
    assert runner.read_history(str(path)) == []


def test_it_prints_the_answer_on_its_marker_line(tmp_path, monkeypatch, capsys):
    clone = _clone(tmp_path / "clone")
    asked: list[dict] = []

    async def fake_completion(prompt, *, system_prompt, project_dir, max_turns):
        asked.append({"project_dir": project_dir, "max_turns": max_turns})
        return ""

    import core.oneshot

    monkeypatch.setattr(core.oneshot, "oneshot_completion", fake_completion)
    code = runner.main(
        ["--project-dir", str(clone), "--question=-admin", "--language=../fr"]
    )
    assert code == 0
    line = capsys.readouterr().out.strip().splitlines()[-1]
    assert line.startswith(runner.MARKER)
    result = json.loads(line[len(runner.MARKER) :])
    assert result["mode"] == "keywords"
    assert [m["taskId"] for m in result["matches"]] == ["001-admin"]
    assert asked == [{"project_dir": str(clone.resolve()), "max_turns": 1}] * 2


@pytest.mark.asyncio
async def test_the_language_is_a_closed_form(tmp_path):
    seen: list[str] = []

    async def complete(prompt, system):
        seen.append(prompt)
        return '{"answer": "ok", "matches": []}' if len(seen) == 2 else ""

    args = runner.parse_args(
        ["--project-dir", str(_clone(tmp_path)), "--question=admin", "--language=de"]
    )
    result = await runner.run(args, complete)
    assert result["mode"] == "ai" and "in German." in seen[1]


def test_the_server_starts_it_as_a_script(tmp_path):
    import subprocess
    import sys
    from pathlib import Path

    script = Path(runner.__file__)
    done = subprocess.run(
        [
            sys.executable,
            str(script),
            "--project-dir",
            str(tmp_path),
            "--question=admin",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    last = done.stdout.strip().splitlines()[-1]
    assert json.loads(last[len(runner.MARKER) :]) == {
        "answer": "",
        "matches": [],
        "mode": "keywords",
        "searched": 0,
    }


def test_a_provider_that_refuses_leaves_the_keyword_answer(
    tmp_path, monkeypatch, capsys
):
    """No OAuth token on the server: the phone still gets the matching cards."""
    clone = _clone(tmp_path / "clone")

    async def refused(prompt, *, system_prompt, project_dir, max_turns):
        raise ValueError("No OAuth token found.")

    import core.oneshot

    monkeypatch.setattr(core.oneshot, "oneshot_completion", refused)
    assert runner.main(["--project-dir", str(clone), "--question=admin page"]) == 0
    out = capsys.readouterr().out.strip().splitlines()
    assert "no answer from the model (ValueError)" in out[0]
    result = json.loads(out[-1][len(runner.MARKER) :])
    assert result["mode"] == "keywords"
    assert [m["taskId"] for m in result["matches"]] == ["001-admin"]
