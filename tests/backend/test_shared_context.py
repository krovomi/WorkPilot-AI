"""Server mode: a project's Context view, its index and its memories.

On the desktop the memories are the person's brain, in their home directory.
On a shared server the home directory is the server user's, one for every
tenant: these tests hold each run to its own project's brain, the Memories
tab to that brain only, and the index to a job of the analyzer on the clone.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_FAKE_KEY = "sk-ant-api03-" + "A" * 24  # pragma: allowlist secret


@pytest.fixture(autouse=True)
def server(monkeypatch, tmp_path):
    for key in list(os.environ):
        if key.startswith("WORKPILOT_") or key.startswith("BRAIN_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_REPOS_ROOT", str(tmp_path / "repos"))
    monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", "off")
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "context.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield tmp_path / "repos"
    server_config.reset_settings_cache()


def _scope(tmp_path: Path, project_id: str, name: str):
    from server.authz.scope import ProjectScope

    clone = tmp_path / "repos" / name
    clone.mkdir(parents=True, exist_ok=True)
    return ProjectScope(project_id, "org-a", clone, "member")


_LEARN = """
import sys
from brain.project_memory import ProjectMemory
memory = ProjectMemory(project_dir=sys.argv[1])
assert memory.record_gotcha(sys.argv[2], solution="Pin the version")
memory.flush()
"""


def _run_learns(scope, text: str, server_env: dict[str, str]) -> None:
    """A run of the project, started as the server starts one, learns ``text``."""
    from server.services.run_env import run_environment
    from server.services.run_manager import confine

    env = run_environment(server_env, {})
    cmd = confine(
        [sys.executable, "-c", _LEARN, str(scope.path), text],
        scope.project_id,
        str(scope.path),
        scope.path.parent,
        env,
    )
    subprocess.run(cmd, cwd=_BACKEND, env=env, check=True, timeout=120)


def test_a_run_learns_into_its_own_project_s_brain(tmp_path):
    from server.services.run_isolation import project_brain
    from shared_features.context import read_memories

    mine = _scope(tmp_path, "proj-a", "alpha")
    theirs = _scope(tmp_path, "proj-b", "beta")
    shared = tmp_path / "operator-brain"
    # The operator's own brain, set on the server: never where a run learns.
    server_env = {
        **os.environ,
        "WORKPILOT_BRAIN_DIR": str(shared),
        "WORKPILOT_BRAIN_CONFIG": str(tmp_path / "operator-brain.json"),
    }
    _run_learns(mine, "The build broke on the lockfile", server_env)

    brain = project_brain(tmp_path / "repos", "proj-a")
    assert brain.is_dir()
    assert not shared.exists()
    # A run writes its brain's files as it likes: what it wrote is served
    # through the redaction all the same.
    (note,) = (brain / "knowledge").rglob("gotchas/*.md")
    text = note.read_text(encoding="utf-8")
    note.write_text(text.replace("## Liens", f"key {_FAKE_KEY}\n\n## Liens"), "utf-8")
    listed = read_memories(mine, "", 20)
    assert listed["available"] is True
    assert any("lockfile" in m["content"] for m in listed["memories"]), listed
    assert all(_FAKE_KEY not in m["content"] for m in listed["memories"])
    assert all(not str(m["path"]).startswith("/") for m in listed["memories"])

    found = read_memories(mine, "lockfile", 20)
    assert found["available"] is True and found["results"]
    assert read_memories(mine, "kubernetes", 20)["results"] == []

    # Another project of the server has no memory of it.
    assert read_memories(theirs, "", 20) == {"available": False, "memories": []}


def test_each_run_is_pointed_at_its_brain_whatever_the_server_says(
    tmp_path, monkeypatch
):
    from server.services.run_env import RUN_ENV, run_environment
    from server.services.run_isolation import project_brain
    from server.services.run_manager import confine

    env = run_environment({"WORKPILOT_BRAIN_DIR": "/srv/everyone"}, {})
    assert "WORKPILOT_BRAIN_DIR" not in env
    assert {"WORKPILOT_BRAIN_DIR", "WORKPILOT_BRAIN_CONFIG"} <= RUN_ENV
    scope = _scope(tmp_path, "proj-a", "alpha")
    for isolation in ("off", "required"):
        monkeypatch.setenv("WORKPILOT_RUN_ISOLATION", isolation)
        env = {}
        confine(["true"], "proj-a", str(scope.path), tmp_path, env)
        brain = project_brain(tmp_path / "repos", "proj-a")
        assert env["WORKPILOT_BRAIN_DIR"] == str(brain)
        assert env["WORKPILOT_BRAIN_CONFIG"] == str(brain.parent / "brain.json")


def test_the_memories_route_takes_a_project_and_reads_its_brain():
    from server.authz.catalog import domain_for_feature
    from server.authz.mounting import permission_for
    from shared_features.context import router

    assert domain_for_feature("context") == "insight"
    assert (
        permission_for("GET", "/api/features/context/memories", "insight")
        == "insight.read"
    )
    (route,) = router.routes
    params = {p.name for p in route.dependant.query_params}
    assert params == {"query", "limit"}
    assert not params & {"project_dir", "path", "brain_dir"}


def test_the_index_is_a_declared_file_rebuilt_by_the_analyzer(tmp_path):
    from shared_features.registry import CONTEXT, FEATURES

    assert FEATURES["context"] is CONTEXT
    assert dict(CONTEXT.files) == {"project_index.json": 4_000_000}
    assert CONTEXT.writable == frozenset()
    assert CONTEXT.args(CONTEXT.options.model_validate({"model": "sonnet"})) == []
    assert (_BACKEND / "runners" / CONTEXT.runner).is_file()

    clone = tmp_path / "clone"
    clone.mkdir()
    (clone / "package.json").write_text(
        json.dumps({"name": "demo", "dependencies": {"react": "^18.0.0"}}),
        encoding="utf-8",
    )
    subprocess.run(
        [
            sys.executable,
            str(_BACKEND / "runners" / CONTEXT.runner),
            "--project",
            str(clone),
        ],
        cwd=_BACKEND,
        check=True,
        timeout=120,
        capture_output=True,
    )
    index = clone / ".workpilot" / "project_index.json"
    assert isinstance(json.loads(index.read_text(encoding="utf-8")), dict)
    assert not [
        p for p in index.parent.iterdir() if p.name.startswith(".project_index.")
    ]
