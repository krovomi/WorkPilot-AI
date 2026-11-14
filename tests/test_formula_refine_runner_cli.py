"""The Formula Refine runner, as the Formula Lab starts it: JSON in, JSON out.

The one model call goes to a stand-in client; the input errors are checked on
the real process.
"""

from __future__ import annotations

import importlib.util
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "formula_refine_runner.py"


def _run(stdin: str) -> tuple[int, dict]:
    done = subprocess.run(
        [sys.executable, str(RUNNER)],
        cwd=BACKEND,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    return done.returncode, json.loads(done.stdout.splitlines()[-1])


def test_an_empty_input_refines_nothing() -> None:
    assert _run("") == (0, {"refined": []})


@pytest.mark.parametrize(
    ("stdin", "error"),
    [
        ("{not json", "Expecting property name"),
        (json.dumps({"candidates": {"key": "a"}}), "candidates must be a list"),
    ],
)
def test_a_bad_input_ends_with_an_error(stdin: str, error: str) -> None:
    code, out = _run(stdin)
    assert code == 1 and error in out["error"]


class ResultMessage:
    def __init__(self, structured_output):
        self.structured_output = structured_output


class StandInClient:
    def __init__(self, **options):
        self.options = options
        self.prompts: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        yield ResultMessage(
            {
                "assessments": [
                    {"key": "fast", "success_probability": 86, "reason": "Small fix."}
                ]
            }
        )


def test_the_model_assessment_comes_back_refined(monkeypatch, capsys) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    import core.simple_client

    clients: list[StandInClient] = []

    def factory(**options):
        clients.append(StandInClient(**options))
        return clients[-1]

    monkeypatch.setattr(core.simple_client, "create_simple_client", factory)
    spec = importlib.util.spec_from_file_location("formula_refine_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    payload = {
        "description": "Fix the cart total",
        "candidates": [
            {"key": "fast", "provider": "claude", "model": "haiku", "effort": "low"}
        ],
    }
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    module.main()
    assert json.loads(capsys.readouterr().out) == {
        "refined": [
            {"key": "fast", "success_probability": 0.86, "reason": "Small fix."}
        ]
    }
    [client] = clients
    assert client.options["max_turns"] == 1
    assert "Fix the cart total" in client.prompts[0]
