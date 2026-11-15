"""`--followup`: a task added to a finished build, then planned."""

from __future__ import annotations

import json

import pytest
from cli import followup_commands as fc


def _answers(monkeypatch, menu, typed=()):
    """Script the menu choices and what is typed after them."""
    choices = list(menu)
    lines = list(typed)
    monkeypatch.setattr(fc, "select_menu", lambda **kwargs: choices.pop(0))

    def fake_input(prompt=""):
        line = lines.pop(0)
        if isinstance(line, BaseException):
            raise line
        return line

    monkeypatch.setattr("builtins.input", fake_input)


def test_a_typed_task_is_saved_for_the_planner(tmp_path, monkeypatch, capsys):
    _answers(monkeypatch, ["type"], ["Add a logout button", "on every page", ""])

    task = fc.collect_followup_task(tmp_path)

    assert task == "Add a logout button\non every page"
    saved = tmp_path / "FOLLOWUP_REQUEST.md"
    assert saved.read_text(encoding="utf-8") == task
    assert "FOLLOW-UP TASK SAVED" in capsys.readouterr().out


def test_a_task_read_from_a_file(tmp_path, monkeypatch):
    source = tmp_path / "task.md"
    source.write_text("\nRename the API.\n", encoding="utf-8")
    _answers(monkeypatch, ["file"], [str(source)])
    assert fc.collect_followup_task(tmp_path) == "Rename the API."


@pytest.mark.parametrize("choice", ["quit", None])
def test_cancel_from_the_menu(tmp_path, monkeypatch, choice):
    _answers(monkeypatch, [choice])
    assert fc.collect_followup_task(tmp_path) is None
    assert not (tmp_path / "FOLLOWUP_REQUEST.md").exists()


@pytest.mark.parametrize(
    ("menu", "typed"),
    [
        (["type"], ["draft", KeyboardInterrupt()]),
        (["file"], [EOFError()]),
    ],
)
def test_ctrl_c_or_end_of_input_cancels(tmp_path, monkeypatch, capsys, menu, typed):
    _answers(monkeypatch, menu, typed)
    assert fc.collect_followup_task(tmp_path) is None
    assert "Cancelled." in capsys.readouterr().out


def test_each_unusable_answer_costs_one_try(tmp_path, monkeypatch, capsys):
    empty = tmp_path / "empty.md"
    empty.write_text("  \n", encoding="utf-8")
    binary = tmp_path / "blob.bin"
    binary.write_bytes(b"\xff\xfe\x00")
    _answers(
        monkeypatch,
        ["file", "file", "file", "file", "paste"],
        ["", str(tmp_path / "missing.md"), str(empty), str(binary), EOFError()],
    )

    assert fc.collect_followup_task(tmp_path, max_retries=5) is None

    out = capsys.readouterr().out
    assert "No file path provided." in out
    assert "File not found:" in out
    assert "File is empty." in out
    assert "Error reading file:" in out
    assert "No task description provided." in out
    assert "Maximum retry attempts reached" in out


def test_a_file_that_cannot_be_read(tmp_path, monkeypatch, capsys):
    locked = tmp_path / "locked.md"
    locked.write_text("x", encoding="utf-8")
    real_read = fc.Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "locked.md":
            raise PermissionError(self)
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(fc.Path, "read_text", read_text)
    _answers(monkeypatch, ["file"], [str(locked)])

    assert fc.collect_followup_task(tmp_path, max_retries=1) is None
    assert "Permission denied: cannot read" in capsys.readouterr().out


def test_the_retry_menu_says_how_many_tries_are_left(tmp_path, monkeypatch):
    subtitles = []

    def menu(**kwargs):
        subtitles.append(kwargs["subtitle"])
        return "type"

    monkeypatch.setattr(fc, "select_menu", menu)
    monkeypatch.setattr("builtins.input", lambda prompt="": "")

    fc.collect_followup_task(tmp_path, max_retries=2)

    assert subtitles[0].startswith("Describe the additional work")
    assert "1 attempts remaining" in subtitles[1]


# --- the command ---------------------------------------------------------


def _plan(spec, statuses, phase_names=("Phase 1",)):
    phases = [
        {
            "name": name,
            "subtasks": [{"id": str(i), "status": s} for i, s in enumerate(statuses)],
        }
        for name in phase_names
    ]
    (spec / "implementation_plan.json").write_text(
        json.dumps({"phases": phases}), encoding="utf-8"
    )


@pytest.fixture
def spec(tmp_path):
    spec = tmp_path / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    return spec


@pytest.fixture
def planner(monkeypatch):
    import agents.planner
    import core.agent
    from cli import utils

    seen = {"result": True, "valid": True}

    async def run_followup_planner(**kwargs):
        seen["kwargs"] = kwargs
        result = seen["result"]
        if isinstance(result, BaseException):
            raise result
        return result

    monkeypatch.setattr(agents.planner, "run_followup_planner", run_followup_planner)
    monkeypatch.setattr(core.agent, "run_followup_planner", run_followup_planner)
    monkeypatch.setattr(utils, "validate_environment", lambda d: seen["valid"])
    monkeypatch.setattr(fc, "collect_followup_task", lambda d: seen.get("task", "x"))
    return seen


def test_a_spec_never_built_cannot_take_a_followup(tmp_path, spec, planner, capsys):
    with pytest.raises(SystemExit) as stop:
        fc.handle_followup_command(tmp_path, spec, "sonnet")
    assert stop.value.code == 1
    assert "No implementation plan found." in capsys.readouterr().out


def test_an_unfinished_build_cannot_take_a_followup(tmp_path, spec, planner, capsys):
    _plan(spec, ["completed", "pending", "pending"])
    with pytest.raises(SystemExit):
        fc.handle_followup_command(tmp_path, spec, "sonnet")
    out = capsys.readouterr().out
    assert "Build not complete (1/3 subtasks)." in out
    assert "still 2 pending subtask(s)" in out


def test_a_finished_build_is_planned_again(tmp_path, spec, planner, capsys):
    _plan(spec, ["completed"], ("Phase 1", "Follow-up: logout", "Followup 2"))

    fc.handle_followup_command(tmp_path, spec, "sonnet", verbose=True, jev_run="j")

    out = capsys.readouterr().out
    assert "(2 prior follow-up(s))" in out
    assert "FOLLOW-UP PLANNING COMPLETE" in out
    assert planner["kwargs"] == {
        "jev_run": "j",
        "project_dir": tmp_path,
        "spec_dir": spec,
        "model": "sonnet",
        "verbose": True,
    }


def test_a_cancelled_task_plans_nothing(tmp_path, spec, planner, capsys):
    _plan(spec, ["completed"])
    planner["task"] = None
    fc.handle_followup_command(tmp_path, spec, "sonnet")
    out = capsys.readouterr().out
    assert "Build is complete. Ready for follow-up tasks." in out
    assert "Follow-up cancelled." in out
    assert "kwargs" not in planner


@pytest.mark.parametrize(
    ("valid", "result", "code", "message"),
    [
        (False, True, 1, None),
        (True, False, 1, "FOLLOW-UP PLANNING INCOMPLETE"),
        (True, KeyboardInterrupt(), 0, "--spec 001-login --followup"),
        (True, RuntimeError("model down"), 1, "Follow-up planning error: model down"),
    ],
)
def test_a_planning_that_does_not_finish(
    tmp_path, spec, planner, capsys, valid, result, code, message
):
    _plan(spec, ["completed"])
    planner["valid"] = valid
    planner["result"] = result

    with pytest.raises(SystemExit) as stop:
        fc.handle_followup_command(tmp_path, spec, "sonnet", verbose=True)

    assert stop.value.code == code
    if message:
        assert message in capsys.readouterr().out
