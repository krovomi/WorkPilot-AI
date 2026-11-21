"""The dictation runner as the app starts it: JSON lines over stdin and stdout.

The real faster-whisper answers the "no model in the cache" case. A session
that transcribes needs a model on disk, so there the recogniser is a stand-in
module placed ahead of the real one on PYTHONPATH; everything around it
(languages, base64, the size bound, the airgap) is the runner's own.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "dictation_runner.py"

STAND_IN = """
import json, os

class _Segment:
    def __init__(self, text):
        self.text = text

class _Info:
    def __init__(self, language):
        self.language = language
        self.language_probability = 0.9


class WhisperModel:
    def __init__(self, name, **options):
        log = os.environ["DICTATION_LOG"]
        with open(log, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"name": name, **options}) + "\\n")
        if os.environ.get("DICTATION_FAIL"):
            raise RuntimeError("no network")

    def transcribe(self, audio, **options):
        words = audio.read().decode("utf-8")
        return [_Segment(" " + words + " "), _Segment("  ")], _Info(options["language"] or "en")
"""


def _run(
    cache: Path, *args: str, stdin: str = "", env: dict | None = None
) -> list[dict]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--cache", str(cache), *args],
        cwd=BACKEND,
        input=stdin,
        env={
            **os.environ,
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            **(env or {}),
        },
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    return [json.loads(line) for line in done.stdout.splitlines()]


@pytest.fixture
def recogniser(tmp_path: Path) -> dict:
    stub = tmp_path / "stub"
    (stub / "faster_whisper").mkdir(parents=True)
    (stub / "faster_whisper" / "__init__.py").write_text(STAND_IN, encoding="utf-8")
    log = tmp_path / "models.log"
    return {
        "env": {"PYTHONPATH": str(stub), "DICTATION_LOG": str(log)},
        "log": log,
    }


def _audio(words: str) -> str:
    return base64.b64encode(words.encode("utf-8")).decode("ascii")


def test_without_a_downloaded_model_it_says_so(tmp_path: Path) -> None:
    assert _run(tmp_path / "empty-cache") == [{"error": "model"}]


def test_a_session_transcribes_each_line(tmp_path: Path, recogniser: dict) -> None:
    requests = [
        {"audio": _audio("Bonjour, Überprüfung mañana."), "language": "fr-CA"},
        {"audio": _audio("hello"), "language": "auto"},
        {"audio": "not base64!", "language": "en"},
        {"audio": _audio("hola"), "language": "klingon"},
        {"language": "en"},
        {"audio": base64.b64encode(b"x" * 8_000_001).decode(), "language": "en"},
    ]
    stdin = "\n".join(json.dumps(r) for r in requests) + "\n{broken\n"

    answers = _run(tmp_path / "cache", stdin=stdin, env=recogniser["env"])

    assert answers == [
        {"ready": True},
        {"text": "Bonjour, Überprüfung mañana."},
        {"text": "hello", "language": "en"},
        {"error": "transcription"},
        {"error": "transcription"},
        {"error": "transcription"},
        {"error": "transcription"},
        {"error": "transcription"},
    ]
    [loaded] = [
        json.loads(x) for x in recogniser["log"].read_text("utf-8").splitlines()
    ]
    # A session never downloads: only what is already in the cache.
    assert loaded["local_files_only"] is True
    assert loaded["download_root"] == str(tmp_path / "cache")


def test_download_needs_a_project_that_allows_the_network(
    tmp_path: Path, recogniser: dict
) -> None:
    assert _run(tmp_path, "--download", env=recogniser["env"]) == [{"error": "offline"}]

    strict = tmp_path / "strict"
    (strict / ".workpilot").mkdir(parents=True)
    (strict / ".workpilot" / "offline-mode.json").write_text(
        json.dumps({"airgapStrict": True, "defaultProvider": "ollama", "routing": {}}),
        encoding="utf-8",
    )
    assert _run(
        tmp_path, "--download", "--project", str(strict), env=recogniser["env"]
    ) == [{"error": "offline"}]
    assert not recogniser["log"].exists()


def test_download_fetches_once_and_returns(tmp_path: Path, recogniser: dict) -> None:
    project = tmp_path / "project"
    project.mkdir()

    answers = _run(
        tmp_path / "cache",
        "--download",
        "--project",
        str(project),
        stdin=json.dumps({"audio": _audio("ignored"), "language": "en"}),
        env=recogniser["env"],
    )

    assert answers == [{"ready": True}]
    [loaded] = [
        json.loads(x) for x in recogniser["log"].read_text("utf-8").splitlines()
    ]
    assert loaded["local_files_only"] is False


def test_a_failed_download_is_reported(tmp_path: Path, recogniser: dict) -> None:
    project = tmp_path / "project"
    project.mkdir()

    answers = _run(
        tmp_path / "cache",
        "--download",
        "--project",
        str(project),
        env={**recogniser["env"], "DICTATION_FAIL": "1"},
    )

    assert answers == [{"error": "download"}]


def test_without_faster_whisper_it_names_the_missing_dependency(
    tmp_path: Path,
) -> None:
    stub = tmp_path / "stub" / "faster_whisper"
    stub.mkdir(parents=True)
    (stub / "__init__.py").write_text(
        "raise ImportError('faster_whisper is not installed')\n", encoding="utf-8"
    )

    answers = _run(tmp_path, env={"PYTHONPATH": str(stub.parent)})

    assert answers == [{"error": "dependency"}]
