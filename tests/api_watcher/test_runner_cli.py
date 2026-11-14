"""The API Watcher runner, run as the API Watcher view runs it.

Every case is the real process on real files: a git repository compared with
its target branch, or a plain folder compared with its saved baseline.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "api_watcher_runner.py"
BASELINE = Path(".workpilot") / "api-contract-baseline.json"

ORDERS = """openapi: 3.0.0
info: {title: Orders, version: "1"}
paths:
  /orders/{id}:
    get: {operationId: getOrder, responses: {"200": {description: ok}}}
  /orders:
    post: {operationId: createOrder, responses: {"201": {description: ok}}}
components:
  schemas:
    Order: {type: object, properties: {id: {type: string}}}
"""
ORDERS_WITHOUT_CREATE = ORDERS.replace(
    '  /orders:\n    post: {operationId: createOrder, responses: {"201": {description: ok}}}\n',
    "",
).replace('version: "1"', 'version: "2"')


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def _write(root: Path, relative: str, text: str) -> None:
    (root / relative).parent.mkdir(parents=True, exist_ok=True)
    (root / relative).write_text(text, encoding="utf-8")


def _run(project: Path, *args: str) -> tuple[int, list[dict], object]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    events, last = [], None
    for line in done.stdout.splitlines():
        prefix, _, payload = line.partition(":")
        if prefix == "API_WATCHER_EVENT":
            events.append(json.loads(payload))
        elif prefix in ("API_WATCHER_RESULT", "API_WATCHER_ERROR"):
            last = (prefix, json.loads(payload))
    return done.returncode, events, last


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "develop")
    _git(root, "config", "user.email", "t@example.test")
    _git(root, "config", "user.name", "t")
    _write(root, "api/openapi.yaml", ORDERS)
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    _git(root, "checkout", "-q", "-b", "feat")
    return root


# --- against the target branch -------------------------------------------------


def test_a_removed_endpoint_breaks_against_the_branch(repo: Path) -> None:
    _write(repo, "api/openapi.yaml", ORDERS_WITHOUT_CREATE)

    code, events, (kind, result) = _run(repo)

    assert (code, kind) == (0, "API_WATCHER_RESULT")
    assert result["mode"] == "branch"
    assert result["diff"]["oldVersion"] == "develop"
    assert result["diff"]["format"] == "openapi"
    assert result["diff"]["breakingCount"] == 1
    assert result["summary"] == "1 contract(s) changed against develop"
    assert "POST /orders" in result["migrationGuideMarkdown"]
    assert "api/openapi.yaml" in result["ciWorkflow"]
    assert events[-1] == {
        "type": "complete",
        "data": {"breaking": 1, "potentiallyBreaking": 0, "nonBreaking": 0},
    }


def test_nothing_changed_against_the_branch(repo: Path) -> None:
    code, _events, (_kind, result) = _run(repo, "--target", "develop")

    assert code == 0
    assert result["diff"]["format"] == "unknown"
    assert result["diff"]["changes"] == []
    assert result["migrationGuideMarkdown"] == ""
    assert result["summary"] == "0 contract(s) changed against develop"


def test_a_named_target_that_cannot_be_compared_says_so(repo: Path) -> None:
    code, _events, (_kind, result) = _run(repo, "--target", "no-such-branch")

    assert code == 0
    assert result["mode"] == "branch"
    assert result["summary"].startswith("Not compared: ")


# --- against the saved baseline --------------------------------------------------


def test_outside_git_the_first_run_saves_a_baseline_then_the_next_one_compares(
    tmp_path: Path,
) -> None:
    _write(tmp_path, "api/openapi.yaml", ORDERS)

    code, _events, (_kind, first) = _run(tmp_path)
    assert code == 0 and first["mode"] == "baseline"
    assert first["summary"].startswith("Baseline saved (1 contract(s))")
    saved = json.loads((tmp_path / BASELINE).read_text(encoding="utf-8"))
    assert list(saved) == [str(Path("api") / "openapi.yaml")]

    _write(tmp_path, "api/openapi.yaml", ORDERS_WITHOUT_CREATE)
    code, events, (_kind, second) = _run(tmp_path)

    assert code == 0
    assert second["diff"]["breakingCount"] == 1
    assert (second["diff"]["oldVersion"], second["diff"]["newVersion"]) == ("1", "2")
    assert second["diff"]["changes"][0]["category"] == "breaking"
    assert second["migrationGuideMarkdown"]
    assert {"type": "progress", "data": {"status": "Diffing against baseline..."}} in (
        events
    )


def test_a_moved_contract_is_compared_with_the_first_one_saved(
    tmp_path: Path,
) -> None:
    _write(tmp_path, "api/openapi.yaml", ORDERS)
    _run(tmp_path)
    (tmp_path / "api" / "openapi.yaml").unlink()
    _write(tmp_path, "contracts/openapi.yaml", ORDERS_WITHOUT_CREATE)

    _code, _events, (_kind, result) = _run(tmp_path, "--mode", "baseline")

    assert result["diff"]["breakingCount"] == 1


def test_save_baseline_starts_over(repo: Path) -> None:
    _run(repo, "--mode", "baseline")
    _write(repo, "api/openapi.yaml", ORDERS_WITHOUT_CREATE)

    _code, _events, (_kind, result) = _run(repo, "--save-baseline")

    assert result["mode"] == "baseline"
    assert result["summary"].startswith("Baseline saved")
    saved = json.loads((repo / BASELINE).read_text(encoding="utf-8"))
    assert [e["method"] for e in next(iter(saved.values()))["endpoints"]] == ["GET"]


def test_a_symlinked_project_path_finds_its_contracts(tmp_path: Path) -> None:
    project = tmp_path / "project"
    _write(project, "api/openapi.yaml", ORDERS)
    link = tmp_path / "link"
    link.symlink_to(project, target_is_directory=True)

    _code, _events, (_kind, result) = _run(link)

    # It used to answer "Found spec files but none could be parsed".
    assert result["summary"].startswith("Baseline saved (1 contract(s))")


@pytest.mark.parametrize(
    ("baseline", "summary"),
    [
        ("{not json", "Failed to read baseline: Expecting property name"),
        ("{}", "Failed to read baseline: it holds no contract"),
        ("[]", "Failed to read baseline: it holds no contract"),
    ],
)
def test_an_unreadable_baseline_is_reported(
    tmp_path: Path, baseline: str, summary: str
) -> None:
    _write(tmp_path, "api/openapi.yaml", ORDERS)
    _write(tmp_path, str(BASELINE), baseline)

    code, _events, (kind, result) = _run(tmp_path)

    assert (code, kind) == (0, "API_WATCHER_RESULT")
    assert result["summary"].startswith(summary)


def test_a_folder_without_contracts(tmp_path: Path) -> None:
    _write(tmp_path, "README.md", "# no API here\n")

    _code, events, (_kind, result) = _run(tmp_path)

    assert result["summary"] == "No API contract specifications found in project"
    assert events[-1]["data"] == {"status": "No API specs found"}
    assert not (tmp_path / BASELINE).exists()


def test_contracts_that_cannot_be_read(tmp_path: Path) -> None:
    _write(tmp_path, "contracts/legacy.wsdl", "<definitions/>\n")
    (tmp_path / "proto").mkdir()
    (tmp_path / "proto" / "users.proto").write_bytes(b"message Us\xe9r {}\n")

    _code, events, (_kind, result) = _run(tmp_path)

    assert result["summary"] == "Found spec files but none could be parsed"
    assert any("Failed to parse users.proto" in e["data"]["status"] for e in events)


def test_a_missing_project_path_is_an_error(tmp_path: Path) -> None:
    code, _events, (kind, message) = _run(tmp_path / "gone")

    assert (code, kind) == (1, "API_WATCHER_ERROR")
    assert message.startswith("Project path does not exist")


def test_a_file_given_as_the_project_is_an_error(tmp_path: Path) -> None:
    _write(tmp_path, "openapi.yaml", ORDERS)

    code, _events, (kind, message) = _run(tmp_path / "openapi.yaml")

    assert (code, kind) == (1, "API_WATCHER_ERROR")
    assert "Not a directory" in message
