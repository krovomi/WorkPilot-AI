"""The Ollama detector the app runs as a script (`ollama_model_detector.py`).

Every command talks to a stand-in Ollama: a real HTTP server on a free local
port that answers `/api/version`, `/api/tags`, `/api/show` and streams
`/api/pull` as NDJSON, the way Ollama does.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
from argparse import Namespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import ollama_model_detector as det
import pytest

BACKEND = Path(det.__file__).resolve().parent


class FakeOllama:
    """What the stand-in answers; each field can be changed by a test."""

    def __init__(self) -> None:
        self.version: object = {"version": "0.12.0"}
        self.tags: object = {
            "models": [
                {"name": "nomic-embed-text:latest", "size": 274_302_450},
                {"name": "qwen2.5-coder:7b", "size": 4_683_087_332},
                {"name": "mystery:latest", "size": True},
                "not a model",
            ]
        }
        self.show: dict[str, object] = {
            "qwen2.5-coder:7b": {
                "capabilities": ["completion", "tools"],
                "details": {"parameter_size": "7.6B"},
            }
        }
        self.pull_lines: list[bytes] = []
        self.pull_status = 200
        self.pulled: list[str] = []


def _handler(fake: FakeOllama):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def _json(self, payload, status=200):
            if payload is None:
                self.send_error(404)
                return
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            routes = {"/api/version": fake.version, "/api/tags": fake.tags}
            self._json(routes.get(self.path))

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            name = json.loads(self.rfile.read(length) or b"{}").get("name", "")
            if self.path == "/api/show":
                self._json(fake.show.get(name))
            elif self.path == "/api/pull":
                fake.pulled.append(name)
                if fake.pull_status != 200:
                    self.send_error(fake.pull_status, "boom")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.end_headers()
                for line in fake.pull_lines:
                    self.wfile.write(line + b"\n")
            else:
                self.send_error(404)

    return Handler


@pytest.fixture
def ollama():
    fake = FakeOllama()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(fake))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield fake
    server.shutdown()
    server.server_close()


@pytest.fixture
def nobody_home():
    """A local URL where nothing listens."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    port = server.server_address[1]
    server.server_close()
    return f"http://127.0.0.1:{port}"


def _run(command, capsys, **args) -> tuple[int, dict, str]:
    with pytest.raises(SystemExit) as exit_:
        command(Namespace(**args))
    out, err = capsys.readouterr()
    return exit_.value.code, json.loads(out.strip().splitlines()[-1]), err


# --- check-status ---------------------------------------------------------------


def test_a_running_server_reports_its_version(ollama, capsys):
    code, answer, _ = _run(det.cmd_check_status, capsys, base_url=ollama.url)

    assert code == 0
    assert answer["data"] == {
        "running": True,
        "url": ollama.url,
        "version": "0.12.0",
        "supports_new_models": True,
    }


def test_without_a_version_endpoint_the_tags_prove_it_runs(ollama, capsys):
    ollama.version = None

    _, answer, _ = _run(det.cmd_check_status, capsys, base_url=ollama.url)

    assert answer["data"]["running"] is True
    assert answer["data"]["version"] == "unknown"


def test_an_answer_without_a_version_is_not_judged(ollama, capsys):
    ollama.version = {"build": "x"}

    _, answer, _ = _run(det.cmd_check_status, capsys, base_url=ollama.url)

    assert answer["data"]["supports_new_models"] is None


def test_a_server_that_is_not_ollama_is_not_running(ollama, capsys):
    ollama.version = ["not", "ollama"]
    ollama.tags = ["neither"]

    _, answer, _ = _run(det.cmd_check_status, capsys, base_url=ollama.url)

    assert answer["data"]["running"] is False


def test_nothing_listening_is_not_running(nobody_home, capsys):
    code, answer, _ = _run(det.cmd_check_status, capsys, base_url=nobody_home)

    assert code == 0
    assert answer["data"]["running"] is False
    assert "not running" in answer["data"]["message"]


# --- listing ----------------------------------------------------------------------


def test_the_models_say_what_they_are_and_whether_they_drive_tools(ollama, capsys):
    _, answer, _ = _run(det.cmd_list_models, capsys, base_url=ollama.url)

    models = {m["name"]: m for m in answer["data"]["models"]}
    assert answer["data"]["count"] == 3
    embed = models["nomic-embed-text:latest"]
    assert embed["is_embedding"] and embed["embedding_dim"] == 768
    assert embed["size_gb"] == 0.26
    assert models["qwen2.5-coder:7b"]["supports_tools"] is True
    # No /api/show for it and an unknown name: not a tool model; a bool is no size.
    assert models["mystery:latest"]["supports_tools"] is False
    assert models["mystery:latest"]["size_bytes"] == 0


def test_listing_without_a_server_is_an_error(nobody_home, capsys):
    code, answer, _ = _run(det.cmd_list_models, capsys, base_url=nobody_home)

    assert code == 1
    assert "Could not connect to Ollama" in answer["error"]


def test_only_embedding_models_sorted_by_name(ollama, capsys):
    ollama.tags = {
        "models": [
            {"name": "mxbai-embed-large", "size": 0},
            {"name": "bge-small-en:latest", "size": 1024**3},
            {"name": "llama3.3", "size": 1},
        ]
    }

    _, answer, _ = _run(det.cmd_list_embedding_models, capsys, base_url=ollama.url)

    assert [m["name"] for m in answer["data"]["embedding_models"]] == [
        "bge-small-en:latest",
        "mxbai-embed-large",
    ]
    assert answer["data"]["embedding_models"][0]["size_gb"] == 1.0


def test_embedding_listing_without_a_server_is_an_error(nobody_home, capsys):
    code, _, _ = _run(det.cmd_list_embedding_models, capsys, base_url=nobody_home)

    assert code == 1


def test_recommended_models_say_what_is_installed_and_usable(ollama, capsys):
    ollama.version = {"version": "0.9.0"}
    ollama.tags = {"models": [{"name": "embeddinggemma:latest"}]}

    _, answer, _ = _run(det.cmd_get_recommended_models, capsys, base_url=ollama.url)

    recommended = {m["name"]: m for m in answer["data"]["recommended"]}
    assert recommended["embeddinggemma"]["installed"] is True
    needs_new = [m for m in recommended.values() if m.get("min_ollama_version")]
    assert needs_new and all(m["compatible"] is False for m in needs_new)
    assert needs_new[0]["compatibility_note"].startswith("Requires Ollama")
    assert answer["data"]["ollama_version"] == "0.9.0"


def test_recommended_models_without_a_server_cannot_be_verified(nobody_home, capsys):
    _, answer, _ = _run(det.cmd_get_recommended_models, capsys, base_url=nobody_home)

    assert all(m["installed"] is False for m in answer["data"]["recommended"])
    notes = {m["compatibility_note"] for m in answer["data"]["recommended"]}
    assert "Version compatibility could not be verified" in notes


# --- pulling ----------------------------------------------------------------------


def _line(payload) -> bytes:
    return json.dumps(payload).encode()


def test_a_pull_streams_its_progress_and_completes(ollama, capsys):
    ollama.pull_lines = [
        _line({"status": "pulling manifest"}),
        b"not json",
        _line(7),
        _line({"status": "downloading", "completed": 5, "total": 10}),
        _line({"status": "success"}),
    ]

    code, answer, err = _run(
        det.cmd_pull_model, capsys, model="llama3.3", base_url=ollama.url
    )

    assert code == 0
    assert answer["data"]["status"] == "completed"
    assert json.loads(err.strip()) == {
        "status": "downloading",
        "completed": 5,
        "total": 10,
    }
    assert ollama.pulled == ["llama3.3"]


def test_a_model_too_new_for_the_server_is_not_pulled(ollama, capsys):
    ollama.version = {"version": "0.9.1"}

    code, answer, _ = _run(
        det.cmd_pull_model, capsys, model="qwen3-embedding:8b", base_url=ollama.url
    )

    assert code == 1
    assert "requires Ollama 0.10.0 or newer" in answer["error"]
    assert ollama.pulled == []


def test_an_error_in_the_stream_is_explained(ollama, capsys):
    ollama.pull_lines = [_line({"error": "pull model manifest: file does not exist"})]

    code, answer, _ = _run(
        det.cmd_pull_model, capsys, model="llama99", base_url=ollama.url
    )

    assert code == 1
    assert "introuvable" in answer["error"]


def test_an_error_in_the_stream_after_the_model_landed_is_a_success(ollama, capsys):
    ollama.tags = {"models": [{"name": "llama3.3:latest"}]}
    ollama.pull_lines = [_line({"error": "remove blob-partial: no such file"})]

    code, answer, _ = _run(
        det.cmd_pull_model, capsys, model="llama3.3", base_url=ollama.url
    )

    assert code == 0
    assert "non-fatal error" in answer["data"]["output"][1]


def test_an_http_error_is_reported(ollama, capsys):
    ollama.tags = {"models": []}
    ollama.pull_status = 500

    code, answer, _ = _run(
        det.cmd_pull_model, capsys, model="llama3.3", base_url=ollama.url
    )

    assert code == 1
    assert "Ollama API error: 500" in answer["error"]


def test_a_pull_without_a_server_is_a_connection_error(nobody_home, capsys):
    code, answer, _ = _run(
        det.cmd_pull_model, capsys, model="llama3.3", base_url=nobody_home
    )

    assert code == 1
    assert "Failed to connect to Ollama" in answer["error"]


def test_a_pull_needs_a_name(capsys):
    code, answer, _ = _run(det.cmd_pull_model, capsys, model="", base_url=None)

    assert code == 1
    assert answer["error"] == "Model name is required"


def test_an_unexpected_failure_while_pulling_is_reported(ollama, capsys, monkeypatch):
    ollama.tags = {"models": []}

    real = det.urllib.request.urlopen

    def broken(request, *args, **kwargs):
        if request.full_url.endswith("/api/pull"):
            raise RuntimeError("socket gremlin")
        return real(request, *args, **kwargs)

    monkeypatch.setattr(det.urllib.request, "urlopen", broken)

    code, answer, _ = _run(
        det.cmd_pull_model, capsys, model="llama3.3", base_url=ollama.url
    )

    assert code == 1
    assert "Failed to pull model: socket gremlin" in answer["error"]


# --- the script ---------------------------------------------------------------------


def _script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(BACKEND / "ollama_model_detector.py"), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )


def test_the_script_answers_one_json_line(ollama):
    result = _script("check-status", "--base-url", ollama.url)

    assert result.returncode == 0
    assert json.loads(result.stdout)["data"]["version"] == "0.12.0"


def test_the_script_without_a_command_prints_help_and_fails():
    result = _script()

    assert result.returncode == 1
    assert "usage:" in result.stdout
    assert json.loads(result.stdout.strip().splitlines()[-1])["error"] == (
        "No command specified"
    )


def test_an_unknown_handler_is_an_error(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["detector", "check-status"])
    monkeypatch.setattr(
        det.argparse.ArgumentParser,
        "parse_args",
        lambda _self: Namespace(command="dance"),
    )

    with pytest.raises(SystemExit) as exit_:
        det.main()

    assert exit_.value.code == 1
    assert "Unknown command: dance" in capsys.readouterr().out


# --- names and sizes ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "dim"),
    [
        ("my-large-embed", 1024),
        ("custom-embed-base", 768),
        ("tiny-embed-mini", 384),
        ("something-embedding", None),
    ],
)
def test_an_unknown_embedding_model_gets_a_dimension_from_its_name(name, dim):
    assert det.get_embedding_dim(name) == dim
    assert det.get_embedding_description(name) == "Embedding model"


def test_versions_compare_by_their_numbers():
    assert det.parse_version("0.10.0-rc1") == (0, 10, 0)
    assert det.parse_version("garbage") == (0, 0, 0)
    assert det.version_gte("0.10.0", "0.9.9")
    assert not det.version_gte(None, "0.1.0")


def test_a_size_comes_from_the_server_before_the_name(ollama):
    meta = det.model_meta(ollama.url, "qwen2.5-coder:7b")

    assert meta == {"supports_tools": True, "tools_known": True, "param_b": 7.6}
    assert det.model_supports_tools(ollama.url, "qwen2.5-coder:7b") is True


def test_a_garbled_reply_is_no_answer(monkeypatch):
    def garbled(*_a, **_k):
        raise det.http.client.IncompleteRead(b"")

    monkeypatch.setattr(det.urllib.request, "urlopen", garbled)

    assert det.fetch_ollama_api("http://127.0.0.1:9", "api/tags") is None


def test_a_tags_answer_without_a_model_list_has_no_model(ollama, capsys):
    ollama.tags = {"models": None}

    _, answer, _ = _run(det.cmd_list_models, capsys, base_url=ollama.url)

    assert answer["data"] == {"models": [], "count": 0, "url": ollama.url}


def test_a_name_with_an_embedding_word_is_an_embedding_model():
    assert det.is_embedding_model("acme-embedding-v1")
    assert not det.is_embedding_model("llama3.3")
