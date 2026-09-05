"""Failures a user can act on.

A test generation that dies has to say *what* died and *where*. These cover the
three layers that carry that: redaction (nothing here may leak a token), the
runner's error protocol, and the classification the UI turns into a hint.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from core.error_details import (  # noqa: E402
    AUTH,
    EMPTY_RESPONSE,
    FILE_NOT_FOUND,
    NETWORK,
    RATE_LIMIT,
    UNKNOWN,
    DetailedError,
    ErrorDetail,
    classify,
    redact,
)


class TestRedaction:
    """The details panel has a copy button — whatever is in it gets pasted."""

    @pytest.mark.parametrize(
        "secret",
        [
            "Authorization: Bearer sk-ant-api03-AAAABBBBCCCCDDDDEEEE1234",
            'api_key="sk-proj-abcdefghijklmnopqrstuvwx"',
            "CLAUDE_CODE_OAUTH_TOKEN=abcdefgh12345678ijklmnop",
            "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
        ],
    )
    def test_credentials_never_survive(self, secret: str) -> None:
        cleaned = redact(f"provider said: {secret}")
        assert "«redacted»" in cleaned
        # The distinctive body of every one of these is >= 16 chars; none of it
        # may remain.
        assert not any(len(word) >= 16 and word.isalnum() for word in cleaned.split())

    def test_leaves_ordinary_diagnostics_alone(self) -> None:
        text = "FileNotFoundError: /home/dev/src/Program.cs line 42"
        assert redact(text) == text

    def test_redacts_through_to_dict(self) -> None:
        payload = ErrorDetail(
            message="failed for Bearer sk-ant-0123456789abcdef",
            details="Bearer sk-ant-0123456789abcdef",
        ).to_dict()
        assert "sk-ant" not in json.dumps(payload)


class TestClassification:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("HTTP 401 Unauthorized", AUTH),
            ("anthropic.RateLimitError: 429", RATE_LIMIT),
            ("ConnectionRefusedError: [Errno 111]", NETWORK),
            ("Cannot read source file: /x.py", FILE_NOT_FOUND),
            ("something entirely novel happened", UNKNOWN),
        ],
    )
    def test_maps_raw_text_to_an_actionable_code(self, text, expected) -> None:
        assert classify(text) == expected

    def test_auth_wins_over_a_coincidental_network_word(self) -> None:
        # A 401 that also mentions a connection is still an auth problem: the
        # hint for the wrong one sends the user to the wrong place.
        assert classify("401 Unauthorized on connection to api") == AUTH

    def test_empty_input_is_unknown_not_a_crash(self) -> None:
        assert classify(None, "", "  ") == UNKNOWN


class TestToDict:
    def test_drops_empty_keys_rather_than_sending_nulls(self) -> None:
        payload = ErrorDetail(message="boom", code=AUTH).to_dict()
        assert payload == {"message": "boom", "code": AUTH}

    def test_keeps_the_tail_of_a_long_traceback(self) -> None:
        # The cause of a Python failure is on its last lines.
        payload = ErrorDetail(
            message="boom", details=("x" * 9000) + "THE-ACTUAL-CAUSE"
        ).to_dict()
        assert payload["details"].endswith("THE-ACTUAL-CAUSE")
        assert len(payload["details"]) <= 4000

    def test_detailed_error_is_a_runtime_error(self) -> None:
        # Callers that caught the plain RuntimeError it replaced still work.
        assert isinstance(DetailedError(ErrorDetail(message="x")), RuntimeError)


class TestCallLlmSurfacesTheRealReason:
    """``oneshot_completion`` swallows provider failures and returns "".

    Before the ``on_error`` hook, every one of them reached the user as "the LLM
    returned an empty response" — the same sentence for an expired token, a
    rate limit and an unreachable endpoint.
    """

    def _agent(self):
        from agents.test_generator import TestGeneratorAgent

        return TestGeneratorAgent()

    def test_provider_failure_is_reported_with_its_own_code(self) -> None:
        import asyncio

        import core.oneshot as oneshot

        class FailingClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_a):
                return False

            async def query(self, _prompt):
                raise RuntimeError("HTTP 429 rate limit exceeded")

            def receive_response(self):  # pragma: no cover — never reached
                raise AssertionError

        original = oneshot._build_client
        oneshot._build_client = lambda *_a, **_k: FailingClient()
        try:
            with pytest.raises(DetailedError) as excinfo:
                asyncio.run(self._agent()._call_llm("PROMPT"))
        finally:
            oneshot._build_client = original

        detail = excinfo.value.detail
        assert detail.code == RATE_LIMIT
        assert detail.stage == "generate"
        assert "429" in detail.message

    def test_a_genuinely_empty_answer_stays_distinguishable(self) -> None:
        import asyncio
        from unittest.mock import patch

        async def empty(*_a, **_k):
            return "   "

        with (
            patch("core.oneshot.oneshot_completion", side_effect=empty),
            pytest.raises(DetailedError) as excinfo,
        ):
            asyncio.run(self._agent()._call_llm("PROMPT"))

        assert excinfo.value.detail.code == EMPTY_RESPONSE

    def test_a_missing_source_file_names_the_file(self) -> None:
        with pytest.raises(DetailedError) as excinfo:
            self._agent().generate_unit_tests("/definitely/not/here.cs")

        detail = excinfo.value.detail
        assert detail.code == FILE_NOT_FOUND
        assert detail.stage == "read"
        assert "/definitely/not/here.cs" in detail.message
        # The reason comes from the read that already happened, not from a
        # second filesystem probe of caller-supplied input (CodeQL flags that,
        # rightly — and the exception is more precise than a stat() anyway).
        assert "FileNotFoundError" in (detail.details or "")

    def test_an_empty_source_file_reads_differently_from_an_unreadable_one(
        self, tmp_path: Path
    ) -> None:
        # Both end the run, and the user's next move is not the same.
        empty = tmp_path / "Empty.cs"
        empty.write_text("", encoding="utf-8")

        with pytest.raises(DetailedError) as excinfo:
            self._agent().generate_unit_tests(str(empty))

        assert "empty" in excinfo.value.detail.message.lower()
        assert "FileNotFoundError" not in (excinfo.value.detail.details or "")


class TestRunnerProtocol:
    """What the Electron main process actually parses off stdout."""

    def _run(self, *args: str) -> str:
        proc = subprocess.run(
            [
                sys.executable,
                str(BACKEND / "runners" / "test_generation_runner.py"),
                *args,
            ],
            capture_output=True,
            text=True,
            cwd=str(BACKEND),
        )
        return proc.stdout

    def test_a_missing_argument_is_reported_on_both_channels(self) -> None:
        out = self._run("--action", "generate-unit")

        structured = [
            json.loads(line[len("__TG_ERROR__:") :])
            for line in out.splitlines()
            if line.startswith("__TG_ERROR__:")
        ]
        assert len(structured) == 1
        assert structured[0]["code"] == "invalid_input"
        # The legacy line keeps an older frontend working.
        assert any(
            line.startswith("__TEST_GENERATION_ERROR__:") for line in out.splitlines()
        )

    def test_a_failure_names_the_stage_it_died_on(self, tmp_path: Path) -> None:
        out = self._run(
            "--action", "generate-unit", "--file-path", str(tmp_path / "nope.py")
        )

        structured = next(
            json.loads(line[len("__TG_ERROR__:") :])
            for line in out.splitlines()
            if line.startswith("__TG_ERROR__:")
        )
        assert structured["code"] == FILE_NOT_FOUND
        assert structured["stage"] == "read"
        # And the stepper is told which step to paint red.
        assert '"stage": "read", "status": "failed"' in out.replace("'", '"') or any(
            json.loads(line[len("__TG_EVENT__:") :]).get("status") == "failed"
            for line in out.splitlines()
            if line.startswith("__TG_EVENT__:")
        )
