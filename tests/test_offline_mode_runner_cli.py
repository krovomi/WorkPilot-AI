"""The Offline Mode runner, run as the Offline Mode page runs it.

The local model servers are real HTTP servers on 127.0.0.1 answering the
Ollama and OpenAI-compatible listing routes; the third runtime points at a
closed port, so it is genuinely down. Policies and caches are real files.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "offline_mode_runner.py"
POLICY = Path(".workpilot") / "offline-mode.json"
CACHE = Path(".workpilot") / "offline-mode-cache.json"

OLLAMA_TAGS = {
    "models": [
        {"name": "qwen3:8b", "size": 5},
        {"name": "llama3.3:latest", "size": 42},
        {"name": "nomic-embed-text:latest", "size": 1},
        {"name": "gpt-oss:120b-cloud", "size": 0},
    ]
}
OPENAI_MODELS = {"data": [{"id": "mistral-small"}, {"id": "text-embedding-3"}]}


class _Models(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - the stdlib's spelling
        body = {
            "/api/tags": OLLAMA_TAGS,
            "/v1/models": OPENAI_MODELS,
        }.get(self.path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        raw = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_args) -> None:
        pass


def _closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture(scope="module")
def models_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Models)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def up(models_server: str) -> dict[str, str]:
    """Ollama and LM Studio running, llama.cpp down."""
    return {
        "OLLAMA_BASE_URL": models_server,
        "LMSTUDIO_BASE_URL": models_server,
        "LLAMA_CPP_BASE_URL": f"http://127.0.0.1:{_closed_port()}",
    }


@pytest.fixture
def down() -> dict[str, str]:
    """No local server at all."""
    closed = f"http://127.0.0.1:{_closed_port()}"
    return {
        "OLLAMA_BASE_URL": closed,
        "LMSTUDIO_BASE_URL": closed,
        "LLAMA_CPP_BASE_URL": closed,
    }


def _run(project: Path, servers: dict[str, str], *args: str) -> tuple[int, dict]:
    env = {k: v for k, v in os.environ.items() if k not in servers}
    env.update(servers)
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    return done.returncode, json.loads(done.stdout.splitlines()[-1])


def _policy(**changes) -> dict:
    policy = {
        "version": 1,
        "airgapStrict": True,
        "defaultProvider": "ollama",
        "routing": {
            "coder": {"provider": "ollama", "model": "qwen3:8b"},
            "summary": {"provider": "lm-studio", "model": "mistral-small"},
        },
        "history": [],
    }
    policy.update(changes)
    return policy


def _set(project: Path, servers: dict[str, str], policy: object) -> tuple[int, dict]:
    return _run(
        project, servers, "--command", "set-policy", "--policy-json", json.dumps(policy)
    )


# --- runtimes and models ---------------------------------------------------------


@pytest.mark.parametrize("command", ["status", "list-models"])
def test_status_lists_generation_models_of_the_running_servers(
    tmp_path: Path, up: dict, command: str
) -> None:
    code, status = _run(tmp_path, up, "--command", command)

    assert code == 0
    assert status["localModels"] == [
        "ollama:qwen3:8b",
        "ollama:llama3.3:latest",
        "lm-studio:mistral-small",
    ]
    assert status["runtimes"]["llamaCpp"] == {"available": False, "models": []}
    assert status["offlineReady"] is True
    assert status["airgapStrict"] is False
    assert status["policyPersisted"] is False
    assert status["policyIsProjectOwn"] is False


def test_status_without_any_server_is_not_offline_ready(
    tmp_path: Path, down: dict
) -> None:
    _code, status = _run(tmp_path, down, "--command", "status")

    assert status["localModels"] == [] and status["offlineReady"] is False


def test_status_names_the_projects_own_strict_policy(tmp_path: Path, up: dict) -> None:
    (tmp_path / POLICY).parent.mkdir()
    (tmp_path / POLICY).write_text(json.dumps(_policy()), encoding="utf-8")

    _code, status = _run(tmp_path, up, "--command", "status")

    assert status["airgapStrict"] is True
    assert status["policyPersisted"] is True
    assert status["policyIsProjectOwn"] is True


def test_the_scan_is_cached_then_forced(tmp_path: Path, up: dict, down: dict) -> None:
    code, first = _run(tmp_path, up, "--command", "scan-models")
    assert code == 0 and first["fromCache"] is False
    assert first["providers"] == {
        "ollama": ["llama3.3:latest", "qwen3:8b"],
        "lm-studio": ["mistral-small"],
        "llama-cpp": [],
    }
    assert first["local"] == {"ollama": True, "lmStudio": True, "llamaCpp": False}
    assert (tmp_path / CACHE).is_file()

    # Servers gone, the cache still answers until it is forced.
    _code, cached = _run(tmp_path, down, "--command", "scan-models")
    assert cached["fromCache"] is True
    assert cached["providers"]["ollama"] == ["llama3.3:latest", "qwen3:8b"]

    _code, forced = _run(tmp_path, down, "--command", "scan-models", "--force")
    assert forced["fromCache"] is False
    assert forced["providers"]["ollama"] == []


@pytest.mark.parametrize(
    "cache",
    [
        "{not json",
        json.dumps({"version": 1, "cachedAt": "2026-11-14T00:00:00+00:00"}),
        json.dumps({"version": 2, "cachedAt": "yesterday"}),
        json.dumps({"version": 2, "cachedAt": "2000-01-01T00:00:00+00:00"}),
    ],
)
def test_a_bad_old_or_stale_cache_is_rebuilt(
    tmp_path: Path, up: dict, cache: str
) -> None:
    (tmp_path / CACHE).parent.mkdir()
    (tmp_path / CACHE).write_text(cache, encoding="utf-8")

    _code, scan = _run(tmp_path, up, "--command", "scan-models")

    assert scan["fromCache"] is False
    assert scan["providers"]["lm-studio"] == ["mistral-small"]


def test_a_project_where_the_cache_cannot_be_written_still_scans(
    tmp_path: Path, up: dict
) -> None:
    (tmp_path / ".workpilot").write_text("not a folder", encoding="utf-8")

    code, scan = _run(tmp_path, up, "--command", "scan-models")

    assert code == 0
    assert scan["providers"]["ollama"] == ["llama3.3:latest", "qwen3:8b"]


# --- the policy --------------------------------------------------------------------


def test_a_new_project_is_offered_a_policy_that_is_not_strict(
    tmp_path: Path, up: dict
) -> None:
    code, answer = _run(tmp_path, up, "--command", "get-policy")

    assert code == 0 and answer["persisted"] is False
    policy = answer["policy"]
    assert policy["airgapStrict"] is False
    assert policy["defaultProvider"] == "ollama"
    assert policy["routing"]["coder"] == {
        "provider": "ollama",
        "model": "llama3.3:latest",
    }
    assert len(policy["routing"]) == 6


def test_without_a_server_the_offer_names_no_model(tmp_path: Path, down: dict) -> None:
    _code, answer = _run(tmp_path, down, "--command", "get-policy")

    assert answer["policy"]["routing"]["planner"] == {"provider": "ollama", "model": ""}


def test_a_valid_policy_is_saved_and_read_back(tmp_path: Path, up: dict) -> None:
    code, saved = _set(tmp_path, up, _policy())

    assert code == 0 and saved["policy"]["airgapStrict"] is True
    on_disk = json.loads((tmp_path / POLICY).read_text(encoding="utf-8"))
    assert on_disk == _policy()
    # The atomic write leaves no temporary file behind.
    assert {p.name for p in (tmp_path / ".workpilot").iterdir()} == {
        "offline-mode.json",
        "offline-mode-cache.json",
    }

    _code, answer = _run(tmp_path, up, "--command", "get-policy")
    assert answer == {"policy": _policy(), "persisted": True}


def test_strict_can_be_lifted_with_every_server_stopped(
    tmp_path: Path, up: dict, down: dict
) -> None:
    _set(tmp_path, up, _policy())

    code, _saved = _set(tmp_path, down, _policy(airgapStrict=False))

    assert code == 0
    on_disk = json.loads((tmp_path / POLICY).read_text(encoding="utf-8"))
    assert on_disk["airgapStrict"] is False


@pytest.mark.parametrize(
    ("policy", "error"),
    [
        ([1, 2], "policy must be a JSON object"),
        (_policy(airgapStrict="yes"), "airgapStrict must be a boolean"),
        (_policy(defaultProvider="anthropic"), "Select a local default provider"),
        (_policy(routing=["coder"]), "routing must be an object"),
        (
            _policy(
                routing={"coder": {"provider": "lm-studio", "model": "mistral-small"}}
            ),
            "Configure a model route for the default local provider",
        ),
        (
            _policy(
                airgapStrict=False,
                routing={"coder": {"provider": "anthropic", "model": "x"}},
            ),
            "Select a local provider for coder",
        ),
        (
            _policy(routing={"coder": {"provider": "ollama", "model": "phi4"}}),
            "Select an available generation model for coder",
        ),
        (
            _policy(routing={"coder": {"provider": "ollama", "model": ""}}),
            "Select an available generation model for coder",
        ),
    ],
)
def test_an_invalid_policy_is_refused_and_not_written(
    tmp_path: Path, up: dict, policy: object, error: str
) -> None:
    code, answer = _set(tmp_path, up, policy)

    assert code == 1
    assert answer == {"error": error}
    assert not (tmp_path / POLICY).exists()


def test_set_policy_needs_a_policy(tmp_path: Path, up: dict) -> None:
    code, answer = _run(tmp_path, up, "--command", "set-policy")

    assert (code, answer) == (1, {"error": "--policy-json is required"})


def test_a_damaged_policy_is_not_replaced_silently(tmp_path: Path, up: dict) -> None:
    (tmp_path / POLICY).parent.mkdir()
    (tmp_path / POLICY).write_text("{half a poli", encoding="utf-8")

    code, answer = _run(tmp_path, up, "--command", "get-policy")
    assert code == 1
    assert answer["error"].startswith("Cannot read offline policy")

    code, _answer = _set(tmp_path, up, _policy())
    assert code == 1
    assert (tmp_path / POLICY).read_text(encoding="utf-8") == "{half a poli"


# --- the routing report --------------------------------------------------------------


@pytest.mark.parametrize(
    ("history", "expected"),
    [
        (
            None,
            {"total": 0, "providers": {}, "mix": {}, "confidentialityLevel": "unknown"},
        ),
        (
            [{"provider": "ollama"}, {"provider": "ollama"}, {"provider": "lm-studio"}],
            {
                "total": 3,
                "providers": {"ollama": 2, "lm-studio": 1},
                "mix": {"ollama": 0.667, "lm-studio": 0.333},
                "confidentialityLevel": "local",
            },
        ),
        (
            [{"provider": "ollama"}, {"provider": "anthropic"}, {}],
            {
                "total": 3,
                "providers": {"ollama": 1, "anthropic": 1, "unknown": 1},
                "mix": {"ollama": 0.333, "anthropic": 0.333, "unknown": 0.333},
                "confidentialityLevel": "mixed",
            },
        ),
    ],
)
def test_the_report_counts_where_tasks_ran(
    tmp_path: Path, up: dict, history, expected: dict
) -> None:
    if history is not None:
        (tmp_path / POLICY).parent.mkdir()
        (tmp_path / POLICY).write_text(
            json.dumps(_policy(history=history)), encoding="utf-8"
        )

    code, report = _run(tmp_path, up, "--command", "report")

    assert code == 0
    assert {k: report[k] for k in expected} == expected
    assert report["history"] == (history or [])


def test_a_missing_project_is_refused(tmp_path: Path, up: dict) -> None:
    code, answer = _run(tmp_path / "gone", up, "--command", "status")

    assert code == 1
    assert answer["error"].startswith("Project not found")


def test_a_policy_path_that_cannot_be_resolved_is_not_the_projects_own(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    from runners import offline_mode_runner

    def unreadable(self, *_a, **_k):
        raise PermissionError("cannot read the parent folder")

    monkeypatch.setattr(Path, "resolve", unreadable)

    assert offline_mode_runner._same_file(str(tmp_path / "x.json"), tmp_path) is False
    assert offline_mode_runner._same_file(None, tmp_path) is False
