"""Ctrl+C during a build: pause, take instructions, resume or quit."""

from __future__ import annotations

import pytest
from cli import build_commands as bc
from foundation.human_input import HUMAN_INPUT_FILE


class _Status:
    log: list = []

    def __init__(self, project_dir):
        pass

    def update(self, state):
        self.log.append(("state", state))

    def set_inactive(self):
        self.log.append(("inactive",))


@pytest.fixture
def paused(tmp_path, monkeypatch):
    import core.agent

    _Status.log = []
    seen = {"menu": [], "typed": [], "resumed": None}
    monkeypatch.setattr(bc, "StatusManager", _Status)
    monkeypatch.setattr(bc, "print_paused_banner", lambda *a, **k: None)

    def menu(**kwargs):
        choice = seen["menu"].pop(0)
        if isinstance(choice, BaseException):
            raise choice
        return choice

    monkeypatch.setattr(bc, "select_menu", menu)
    monkeypatch.setattr(bc, "read_multiline_input", lambda prompt: seen["typed"].pop(0))
    monkeypatch.setattr(bc, "read_from_file", lambda: seen["typed"].pop(0))

    async def resume(**kwargs):
        seen["resumed"] = kwargs

    monkeypatch.setattr(core.agent, "run_autonomous_agent", resume)

    spec = tmp_path / "worktree-spec"
    source = tmp_path / "project-spec"
    spec.mkdir()
    source.mkdir()

    def run(worktree_manager=None):
        bc._handle_build_interrupt(
            spec_dir=spec,
            source_spec_dir=source,
            project_dir=tmp_path,
            worktree_manager=worktree_manager,
            working_dir=tmp_path / "work",
            model="sonnet",
            max_iterations=4,
            verbose=False,
            profile="profile",
            jev_run="run",
            streaming_session_id="live-1",
        )

    seen["run"], seen["spec"], seen["source"] = run, spec, source
    return seen


def test_continuing_resumes_the_build_with_its_live_session(paused):
    """The resumed build used to read a name this function never defined."""
    paused["menu"] = ["skip"]
    with pytest.raises(SystemExit) as stop:
        paused["run"]()
    assert stop.value.code == 0
    resumed = paused["resumed"]
    assert resumed["streaming_session_id"] == "live-1"
    assert (resumed["profile"], resumed["jev_run"]) == ("profile", "run")
    assert resumed["source_spec_dir"] == paused["source"]
    assert ("state", bc.BuildState.BUILDING) in _Status.log


@pytest.mark.parametrize("choice", ["type", "paste", "file"])
def test_instructions_reach_both_copies_of_the_spec(paused, capsys, choice):
    paused["menu"] = [choice]
    paused["typed"] = ["Use the cache."]

    paused["run"](worktree_manager=object())

    for spec in (paused["spec"], paused["source"]):
        assert (spec / HUMAN_INPUT_FILE).read_text(encoding="utf-8").strip() == (
            "Use the cache."
        )
    out = capsys.readouterr().out
    assert "INSTRUCTIONS SAVED" in out
    assert "--spec worktree-spec" in out
    assert "separate workspace" in out
    assert paused["resumed"] is None


@pytest.mark.parametrize("typed", ["", None])
def test_a_file_without_instructions(paused, capsys, typed):
    paused["menu"] = ["file"]
    paused["typed"] = [typed]
    paused["run"]()
    assert "No instructions provided." in capsys.readouterr().out
    assert not (paused["spec"] / HUMAN_INPUT_FILE).exists()


@pytest.mark.parametrize(
    ("menu", "typed"),
    [(["quit"], []), ([None], []), (["type"], [None]), ([KeyboardInterrupt()], [])],
)
def test_quitting_marks_the_build_inactive(paused, menu, typed):
    paused["menu"] = menu
    paused["typed"] = typed
    with pytest.raises(SystemExit) as stop:
        paused["run"]()
    assert stop.value.code == 0
    assert ("inactive",) in _Status.log
    assert paused["resumed"] is None


def test_a_closed_input_shows_how_to_resume(paused, capsys):
    paused["menu"] = [EOFError()]
    paused["run"]()
    out = capsys.readouterr().out
    assert "TO RESUME" in out
    assert "separate workspace" not in out
