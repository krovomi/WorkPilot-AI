"""The repair loop stops when repairing stops helping.

No model and no renderer here: `cli.validate` and `cli.deliver` are replaced,
because what is under test is the *stopping rule*, and a real renderer would
make the test about diagram geometry instead.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from architecture_visualizer.archify import authoring, cli


def valid_model() -> dict:
    return {
        "schema_version": 1,
        "diagram_type": "architecture",
        "meta": {"title": "T", "quality_profile": "showcase"},
        "components": [{"id": "a", "type": "backend", "label": "A"}],
    }


def receipt(ok: bool, count: int = 0) -> cli.Receipt:
    return cli.Receipt(
        ok=ok,
        command="validate",
        payload={
            "ok": ok,
            "diagnostics": [{"code": f"x/{i}", "message": "m"} for i in range(count)],
        },
    )


class Recorder:
    """A stand-in session: writes the model and counts the prompts it saw."""

    def __init__(self, spec_path: Path):
        self.spec_path = spec_path
        self.prompts: list[str] = []

    async def __call__(self, prompt: str) -> str:
        self.prompts.append(prompt)
        self.spec_path.write_text(json.dumps(valid_model()), encoding="utf-8")
        return "written"


@pytest.fixture
def patched(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(authoring, "build_prompt", lambda **_kwargs: "author the model")
    monkeypatch.setattr(
        authoring.ir_module, "pin_repository", lambda ir, *_a, **_k: (ir, None)
    )
    return tmp_path


class TestAuthor:
    @pytest.mark.asyncio
    async def test_a_first_pass_that_validates_is_delivered(
        self, patched: Path, monkeypatch
    ):
        spec = patched / "m.json"
        monkeypatch.setattr(cli, "validate", lambda *_a, **_k: receipt(True))
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_path=spec,
            artifact_path=patched / "m.html",
        )
        assert result.ok
        assert result.rounds == 1
        assert len(session.prompts) == 1

    @pytest.mark.asyncio
    async def test_it_repairs_while_the_error_count_falls(
        self, patched: Path, monkeypatch
    ):
        spec = patched / "m.json"
        counts = iter([3, 2, 0])
        monkeypatch.setattr(
            authoring.cli,
            "validate",
            lambda *_a, **_k: (lambda n: receipt(n == 0, n))(next(counts)),
        )
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_path=spec,
            artifact_path=patched / "m.html",
        )
        assert result.ok
        assert result.rounds == 3
        # The second and third prompts are repair prompts, not the original.
        assert "Repair the architecture model" in session.prompts[1]

    @pytest.mark.asyncio
    async def test_it_stops_after_two_rounds_without_a_new_best(
        self, patched: Path, monkeypatch
    ):
        """The stopping rule, and the reason it is progress and not a count.

        A round that does not lower the error count learned nothing from the
        diagnostics, so the next one will not either. Four identical rounds
        would spend a build's budget to produce the same refusal.
        """
        spec = patched / "m.json"
        monkeypatch.setattr(
            authoring.cli, "validate", lambda *_a, **_k: receipt(False, 2)
        )
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_path=spec,
            artifact_path=patched / "m.html",
        )
        assert not result.ok
        assert result.rounds == 3, "one round to set the best, two stalls"
        assert len(result.diagnostics) == 2
        assert result.error

    @pytest.mark.asyncio
    async def test_it_never_exceeds_the_ceiling(self, patched: Path, monkeypatch):
        """Even while the count keeps improving, there is a hard stop."""
        spec = patched / "m.json"
        counts = iter([9, 8, 7, 6, 5, 4])
        monkeypatch.setattr(
            authoring.cli,
            "validate",
            lambda *_a, **_k: receipt(False, next(counts)),
        )
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_path=spec,
            artifact_path=patched / "m.html",
        )
        assert not result.ok
        assert result.rounds == authoring.MAX_ROUNDS

    @pytest.mark.asyncio
    async def test_a_session_that_writes_nothing_is_reported_as_such(
        self, patched: Path, monkeypatch
    ):
        spec = patched / "m.json"

        async def silent(_prompt: str) -> str:
            return "I thought about it"

        result = await authoring.author(
            session=silent,
            project_dir=patched,
            spec_path=spec,
            artifact_path=patched / "m.html",
        )
        assert not result.ok
        assert "wrote no model" in result.error

    @pytest.mark.asyncio
    async def test_unreadable_output_goes_back_through_the_repair_loop(
        self, patched: Path, monkeypatch
    ):
        """Malformed JSON is a diagnosable failure, not the end of the run."""
        spec = patched / "m.json"
        attempts = {"n": 0}

        async def flaky(_prompt: str) -> str:
            attempts["n"] += 1
            if attempts["n"] == 1:
                spec.write_text("not json at all", encoding="utf-8")
            else:
                spec.write_text(json.dumps(valid_model()), encoding="utf-8")
            return "written"

        monkeypatch.setattr(cli, "validate", lambda *_a, **_k: receipt(True))
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))

        result = await authoring.author(
            session=flaky,
            project_dir=patched,
            spec_path=spec,
            artifact_path=patched / "m.html",
        )
        assert result.ok
        assert result.rounds == 2

    @pytest.mark.asyncio
    async def test_a_failed_delivery_is_not_reported_as_success(
        self, patched: Path, monkeypatch
    ):
        """Delivery re-renders the frozen bytes and can refuse what validate took.

        A failed delivery also leaves any previous artifact in place, so
        reporting success here would hand the caller a stale file.
        """
        spec = patched / "m.json"
        monkeypatch.setattr(authoring.cli, "validate", lambda *_a, **_k: receipt(True))
        monkeypatch.setattr(
            authoring.cli, "deliver", lambda *_a, **_k: receipt(False, 1)
        )
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_path=spec,
            artifact_path=patched / "m.html",
        )
        assert not result.ok
        assert result.artifact_path is None
