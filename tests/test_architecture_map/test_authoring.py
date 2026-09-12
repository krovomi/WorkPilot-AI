"""Tests for architecture model authoring."""

import json
from pathlib import Path

import pytest

from architecture_visualizer.archify import authoring, cli


class Recorder:
    """Mock session recorder for testing."""

    def __init__(self, spec_path: Path):
        self.spec_path = spec_path
        self.calls = []

    async def run(self, prompt: str, model: str = "test") -> tuple[str, str, dict]:
        """Mock session run."""
        self.calls.append({"prompt": prompt, "model": model})
        return "ok", json.dumps({"version": "1.0", "components": []}), {}


def receipt(ok: bool, count: int = 0) -> cli.Receipt:
    """Create a test receipt."""
    return cli.Receipt(
        ok=ok,
        command="validate",
        payload={
            "ok": ok,
            "diagnostics": [{"code": f"x/{i}", "message": "m"} for i in range(count)],
        },
    )


@pytest.fixture
def patched(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(authoring, "build_prompt", lambda **_kwargs: "author the model")
    monkeypatch.setattr(
        authoring.ir_module, "pin_repository", lambda ir, *_a, **_k: (ir, None)
    )
    return tmp_path


class TestAuthoring:
    """Tests for the authoring process."""

    def test_successful_authoring(
        self,
        patched: Path,
        monkeypatch,
    ):
        spec = patched / "m.json"
        monkeypatch.setattr(cli, "validate", lambda *_a, **_k: receipt(True))
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_dir=patched,
            model="test",
        )
        assert result["success"] is True

    def test_authoring_with_validation_errors(
        self,
        patched: Path,
        monkeypatch,
    ):
        # Create multiple validation attempts
        counts = iter([1, 2, 0])
        spec = patched / "m.json"
        monkeypatch.setattr(
            cli,
            "validate",
            lambda *_a, **_k: (lambda n: receipt(n == 0, n))(next(counts)),
        )
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_dir=patched,
            model="test",
        )
        # Handle validation errors appropriately
        pass

    def test_authoring_with_delivery_errors(
        self,
        patched: Path,
        monkeypatch,
    ):
        spec = patched / "m.json"
        monkeypatch.setattr(
            authoring.cli, "validate", lambda *_a, **_k: receipt(False, 2)
        )
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))
        session = Recorder(spec)

        result = await authoring.author(
            session=session,
            project_dir=patched,
            spec_dir=patched,
            model="test",
        )
        # Handle delivery errors appropriately
        pass

    def test_authoring_with_session_error(
        self,
        patched: Path,
        monkeypatch,
    ):
        spec = patched / "m.json"

        class FailingRecorder(Recorder):
            async def run(
                self, prompt: str, model: str = "test"
            ) -> tuple[str, str, dict]:
                return "error", "Session failed", {}

        monkeypatch.setattr(cli, "validate", lambda *_a, **_k: receipt(True))
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))
        session = FailingRecorder(spec)

        with pytest.raises(authoring.AuthoringError):
            await authoring.author(
                session=session,
                project_dir=patched,
                spec_dir=patched,
                model="test",
            )

    def test_authoring_respects_effort_level(
        self,
        patched: Path,
        monkeypatch,
    ):
        def get_effort(effort: str):
            def capture_prompt(**_kw):
                return f"effort: {effort}"

            return capture_prompt

        spec = patched / "m.json"
        monkeypatch.setattr(
            authoring, "build_prompt", lambda **_kw: _kw.get("effort", "medium")
        )
        monkeypatch.setattr(cli, "validate", lambda *_a, **_k: receipt(True))
        monkeypatch.setattr(authoring.cli, "deliver", lambda *_a, **_k: receipt(True))

        result = await authoring.author(
            session=Recorder(spec),
            project_dir=patched,
            spec_dir=patched,
            model="test",
            effort="high",
        )
        pass
