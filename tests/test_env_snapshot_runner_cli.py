"""The environment snapshot runner, as the desktop app starts it.

`python runners/env_snapshot_runner.py --command <c> --project-path <dir>`
prints one line of JSON. These tests capture a snapshot of a real git
project, read it back, replay it in each format and export it, and check
that secrets never reach the snapshot file. Every value below is a
placeholder.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "env_snapshot_runner.py"


def _git(project: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args], cwd=project, check=True, capture_output=True, text=True
    )


def _run(project: Path, *args: str, env: dict | None = None) -> tuple[int, dict]:
    base = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**base, **(env or {})},
        timeout=180,
        check=False,
    )
    lines = done.stdout.strip().splitlines()
    assert len(lines) == 1, done.stdout + done.stderr
    return done.returncode, json.loads(lines[0])


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "dev@example.test")
    _git(root, "config", "user.name", "Dev")
    _git(root, "remote", "add", "origin", "https://example.test/acme/shop.git")
    # Bytes, not text: on Windows, text mode writes "\r\n" and .nvmrc is 4 bytes.
    (root / "package-lock.json").write_bytes(b'{"lockfileVersion": 3}\n')
    (root / ".nvmrc").write_bytes(b"22\n")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "start")
    (root / "notes.txt").write_text("wip\n", encoding="utf-8")
    return root


@pytest.fixture
def snapshot(project: Path) -> dict:
    env = {
        "SHOP_API_TOKEN": "placeholder-value",
        "SHOP_DATABASE_URL": "postgres://app:placeholder@db.example.test/shop",
        "SHOP_REGION": "eu-west",
    }
    code, out = _run(
        project,
        "--command",
        "capture",
        "--label",
        "before upgrade",
        "--spec-id",
        "012-cart",
        env=env,
    )
    assert code == 0, out
    return out["snapshot"]


def test_a_capture_records_os_tools_lockfiles_and_git(
    project: Path, snapshot: dict
) -> None:
    assert snapshot["id"].startswith("snap-")
    assert snapshot["label"] == "before upgrade"
    assert snapshot["specId"] == "012-cart"
    assert snapshot["os"]["python"].count(".") == 2
    # The tool that runs the tests is on the PATH: git answers with its version.
    assert snapshot["tools"]["git"].startswith("git version")
    assert snapshot["tools"]["python"]
    assert [lock["name"] for lock in snapshot["lockfiles"]] == [
        "package-lock.json",
        ".nvmrc",
    ]
    assert snapshot["lockfiles"][1]["size"] == "3"
    assert len(snapshot["lockfiles"][0]["sha256"]) == 64
    git = snapshot["git"]
    assert git["branch"] == "main" and len(git["commit"]) == 40
    assert git["remote"] == "https://example.test/acme/shop.git"
    assert git["dirty"] == ["?? notes.txt"]
    stored = project / ".workpilot" / "env-snapshots" / f"{snapshot['id']}.json"
    assert json.loads(stored.read_text(encoding="utf-8")) == snapshot


def test_secrets_never_reach_the_snapshot(project: Path, snapshot: dict) -> None:
    env = snapshot["env"]
    assert env["SHOP_API_TOKEN"] == "<redacted>"
    assert env["SHOP_DATABASE_URL"] == "postgres://<redacted>@db.example.test/shop"
    assert env["SHOP_REGION"] == "eu-west"
    files = (project / ".workpilot" / "env-snapshots").glob("*.json")
    assert all("placeholder" not in f.read_text(encoding="utf-8") for f in files)


def test_snapshots_are_listed_newest_first_and_read_back(
    project: Path, snapshot: dict
) -> None:
    folder = project / ".workpilot" / "env-snapshots"
    older = dict(snapshot, id="snap-1-abcdef", createdAt="2020-01-01T00:00:00+00:00")
    (folder / "snap-1-abcdef.json").write_text(json.dumps(older), encoding="utf-8")
    (folder / "snap-2-broken.json").write_text("{not json", encoding="utf-8")

    code, out = _run(project, "--command", "list")
    assert code == 0
    assert [s["id"] for s in out["snapshots"]] == [snapshot["id"], "snap-1-abcdef"]

    code, out = _run(project, "--command", "get", "--snap-id", snapshot["id"])
    assert code == 0 and out["snapshot"] == snapshot


@pytest.mark.parametrize(
    ("fmt", "marker"),
    [("dockerfile", "FROM "), ("nix", "mkShell"), ("script", "#!")],
)
def test_each_replay_format_is_built_without_running_it(
    project: Path, snapshot: dict, fmt: str, marker: str
) -> None:
    code, out = _run(
        project, "--command", "replay", "--snap-id", snapshot["id"], "--format", fmt
    )
    assert code == 0, out
    assert out["format"] == fmt and marker in out["payload"]


def test_an_export_stays_in_the_exports_folder(project: Path, snapshot: dict):
    exports = project / ".workpilot" / "env-snapshots" / "exports"
    code, out = _run(project, "--command", "export", "--snap-id", snapshot["id"])
    assert code == 0
    assert Path(out["path"]) == exports / f"{snapshot['id']}.Dockerfile"
    code, out = _run(
        project,
        "--command",
        "export",
        "--snap-id",
        snapshot["id"],
        "--format",
        "script",
        "--output",
        "../../../escape.sh",
    )
    assert code == 0
    assert Path(out["path"]) == exports / "escape.sh"
    assert "#!" in (exports / "escape.sh").read_text(encoding="utf-8")
    assert not (project / "escape.sh").exists()


@pytest.mark.parametrize("command", ["get", "replay", "export"])
def test_an_id_is_required_and_must_name_a_snapshot(project: Path, command: str):
    code, out = _run(project, "--command", command)
    assert code == 1 and out["error"].startswith("--snap-id required")
    for bad in ("../../etc/passwd", "snap-9-abcdef"):
        code, out = _run(project, "--command", command, "--snap-id", bad)
        assert code == 1 and out == {"error": bad}


def test_a_damaged_snapshot_reads_as_missing(project: Path) -> None:
    folder = project / ".workpilot" / "env-snapshots"
    folder.mkdir(parents=True)
    (folder / "snap-3-abcdef.json").write_text("{", encoding="utf-8")
    code, out = _run(project, "--command", "get", "--snap-id", "snap-3-abcdef")
    assert code == 1 and out == {"error": "snap-3-abcdef"}


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    code, out = _run(tmp_path / "gone", "--command", "list")
    assert code == 1 and out["error"].startswith("Project not found:")


# --- in-process: the tool probes and the unknown replay format -------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("env_snapshot_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_tool_version_is_the_first_line_with_a_digit(runner, monkeypatch):
    monkeypatch.setattr(runner.shutil, "which", lambda name: f"/bin/{name}")
    monkeypatch.setattr(
        runner, "_run_cmd", lambda cmd: "\n------\nGradle 8.10.2\nBuild time: 2024"
    )
    assert runner._tool_version("gradle") == "Gradle 8.10.2"
    monkeypatch.setattr(runner, "_run_cmd", lambda cmd: "no digits here")
    assert runner._tool_version("gradle") is None


def test_an_absent_or_broken_tool_has_no_version(runner, monkeypatch) -> None:
    monkeypatch.setattr(runner.shutil, "which", lambda name: None)
    assert runner._tool_version("dotnet") is None
    assert runner._run_cmd(["no-such-tool-for-workpilot"]) == ""


def test_python_falls_back_to_the_windows_name(runner, monkeypatch) -> None:
    asked = []

    def version(name, arg="--version"):
        asked.append(name)
        return "Python 3.12.0" if name == "python" else None

    monkeypatch.setattr(runner, "_tool_version", version)
    assert runner._tool_versions()["python"] == "Python 3.12.0"
    assert asked[-1] == "python"


def test_an_unreadable_lockfile_has_no_hash(runner, tmp_path: Path) -> None:
    assert runner._hash_file(tmp_path / "missing.lock") is None


def test_an_unknown_replay_format_is_refused(runner) -> None:
    with pytest.raises(ValueError, match="Unknown replay format: helm"):
        runner._replay_payload({}, "helm")
