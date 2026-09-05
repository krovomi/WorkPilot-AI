#!/usr/bin/env python3
"""What counts as a failed model download, and how it is explained.

Two defects motivated this file, both reported from the same toast:

    Impossible de récupérer « llama3.3 » : ce dépôt Hugging Face ne fournit pas
    de version GGUF (requise par Ollama). […] Détail : remove
    /home/…/.ollama/models/blobs/sha256-…-partial-5: no such file or directory

1. **The message was about the wrong thing.** The classifier matched the bare
   substring ``"no such"``, which also occurs in ``no such file or directory``,
   so a local filesystem error was reported as a Hugging Face repository
   lacking a GGUF build. It named the wrong subsystem, the wrong fix, and a
   repository the user had never mentioned.

2. **The download had in fact succeeded.** Ollama fetched every layer and then
   failed to unlink a ``-partial`` blob. The model was on disk and usable, and
   the user was told to redo gigabytes of work.

So the rule is: ask the server whether the model is there, and only explain an
error when it genuinely is not.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from ollama_model_detector import (  # noqa: E402
    classify_pull_error,
    model_is_installed,
)

# The real message from the bug report, trimmed of its hash.
PARTIAL_BLOB_ERROR = (
    "remove /home/leub/.ollama/models/blobs/"
    "sha256-4824460d29f2058aaf6e1118a63a7a197a09bed509f0e7d4-partial-5: "
    "no such file or directory"
)


def tags(*names: str) -> dict:
    return {"models": [{"name": n} for n in names]}


class TestClassification:
    def test_a_filesystem_error_is_not_blamed_on_hugging_face(self):
        """The exact mis-classification the user saw."""
        message = classify_pull_error("llama3.3", PARTIAL_BLOB_ERROR, "0.5.0")
        assert "Hugging Face" not in message
        assert "GGUF" not in message
        # …and the raw detail is still carried, so nothing is hidden.
        assert "no such file or directory" in message

    def test_a_missing_gguf_build_still_says_so(self):
        message = classify_pull_error(
            "hf.co/org/model",
            "error converting model: no GGUF file found in repository",
            "0.5.0",
        )
        assert "GGUF" in message

    def test_an_unknown_name_says_the_registry_does_not_know_it(self):
        message = classify_pull_error(
            "llama99", "pull model manifest: file does not exist", "0.5.0"
        )
        assert "introuvable" in message
        assert "GGUF" not in message

    def test_a_version_requirement_is_named(self):
        message = classify_pull_error(
            "gemma3", "requires a newer version of Ollama", "0.1.0"
        )
        assert "0.1.0" in message
        assert "ollama.com/download" in message

    def test_a_full_disk_says_so(self):
        message = classify_pull_error(
            "llama3.3", "write blob: no space left on device", None
        )
        assert "Espace disque" in message

    def test_a_dropped_connection_says_a_retry_resumes(self):
        # Ollama resumes a partial pull, so "start over" would be wrong advice.
        message = classify_pull_error("llama3.3", "unexpected EOF", None)
        assert "Relancez" in message

    def test_an_unrecognised_error_is_passed_through_verbatim(self):
        # Better a raw message than a confident wrong one.
        assert classify_pull_error("llama3.3", "something odd", None) == "something odd"

    def test_whitespace_and_newlines_are_collapsed(self):
        assert classify_pull_error("m", "a\n  b\tc", None) == "a b c"

    def test_an_empty_error_still_produces_a_message(self):
        assert classify_pull_error("m", "", None) == "erreur inconnue"


class TestInstalledCheck:
    """The question that decides success, so its matching has to be right."""

    def _with_tags(self, payload):
        return patch("ollama_model_detector.fetch_ollama_api", return_value=payload)

    def test_a_bare_name_matches_its_latest_tag(self):
        # Ollama stores `llama3.3` as `llama3.3:latest`; a literal comparison
        # would have reported a freshly pulled model as missing.
        with self._with_tags(tags("llama3.3:latest")):
            assert model_is_installed("http://x", "llama3.3") is True

    def test_a_bare_name_matches_an_explicit_size_tag(self):
        with self._with_tags(tags("llama3.3:70b")):
            assert model_is_installed("http://x", "llama3.3") is True

    def test_an_exact_tag_matches(self):
        with self._with_tags(tags("qwen3-embedding:8b")):
            assert model_is_installed("http://x", "qwen3-embedding:8b") is True

    def test_a_tagged_request_does_not_match_a_different_tag(self):
        with self._with_tags(tags("llama3.3:70b")):
            assert model_is_installed("http://x", "llama3.3:8b") is False

    def test_a_different_model_does_not_match(self):
        with self._with_tags(tags("mistral:latest", "gemma3:latest")):
            assert model_is_installed("http://x", "llama3.3") is False

    def test_matching_ignores_case(self):
        with self._with_tags(tags("Llama3.3:latest")):
            assert model_is_installed("http://x", "LLAMA3.3") is True

    def test_an_unreachable_server_is_not_a_match(self):
        # Fail closed: without an answer we must not claim the model is there.
        with self._with_tags(None):
            assert model_is_installed("http://x", "llama3.3") is False

    def test_an_empty_name_is_never_installed(self):
        with self._with_tags(tags("llama3.3:latest")):
            assert model_is_installed("http://x", "") is False


class TestPullReportsTheEndState:
    """A pull is judged by whether the model is usable, not by its exit path."""

    def _run_pull(self, stream_lines: list[dict], installed: bool):
        """Drive `cmd_pull_model` over a canned /api/pull stream.

        Returns the result document plus the process exit code, because the
        Electron handler reads both: it parses stdout first and falls back to
        the code, so the two must agree.
        """
        import ollama_model_detector as det

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def __iter__(self):
                for line in stream_lines:
                    yield (json.dumps(line) + "\n").encode()

        printed: list[str] = []
        with (
            patch.object(det.urllib.request, "urlopen", lambda *a, **k: FakeResponse()),
            patch.object(det, "get_ollama_version", return_value="0.5.0"),
            patch.object(det, "model_is_installed", return_value=installed),
            patch("builtins.print", lambda *a, **k: printed.append(str(a[0]))),
            pytest.raises(SystemExit) as exit_info,
        ):
            det.cmd_pull_model(
                type("Args", (), {"model": "llama3.3", "base_url": "http://x"})()
            )
        # The structured document goes to stdout; progress goes to stderr.
        for line in printed:
            try:
                doc = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "success" in doc:
                return doc, exit_info.value.code
        raise AssertionError(f"no result document was written: {printed}")

    def test_a_cleanup_error_on_an_installed_model_is_a_success(self):
        """The user's case: 100% downloaded, then a failed blob unlink."""
        result, code = self._run_pull(
            [{"completed": 100, "total": 100}, {"error": PARTIAL_BLOB_ERROR}],
            installed=True,
        )
        assert result["success"] is True
        assert code == 0
        assert result["data"]["status"] == "completed"
        # The oddity is still recorded rather than swallowed.
        assert any("non-fatal" in line for line in result["data"]["output"])

    def test_the_same_error_on_a_missing_model_is_a_failure(self):
        result, code = self._run_pull([{"error": PARTIAL_BLOB_ERROR}], installed=False)
        assert result["success"] is False
        assert code == 1
        assert "Hugging Face" not in result["error"]

    def test_a_clean_pull_succeeds(self):
        result, code = self._run_pull(
            [{"completed": 50, "total": 100}, {"status": "success"}], installed=True
        )
        assert result["success"] is True
        assert code == 0


class TestAgentClientParity:
    """The mid-run auto-pull answers the same question the same way.

    Two code paths pull models — this one and the detector — and a user cannot
    tell which produced a given message. They must not disagree about whether a
    download succeeded.
    """

    def test_the_stream_verifies_before_reporting_a_failure(self):
        source = (
            REPO_ROOT / "apps" / "backend" / "core" / "agent_client.py"
        ).read_text(encoding="utf-8")
        assert "async def _model_is_installed" in source
        # Both the in-stream error and the transport error consult it.
        assert source.count("if await self._model_is_installed():") >= 2

    def test_the_partial_blob_case_is_explained(self):
        from core.agent_client import LocalAgentClient

        message = LocalAgentClient._explain_pull_error("llama3.3", PARTIAL_BLOB_ERROR)
        assert "GGUF" not in message
        assert "introuvable" not in message


if __name__ == "__main__":  # pragma: no cover
    sys.exit(pytest.main([__file__, "-v"]))
