"""The reinforced sandbox's write rules, and the barriers that apply them.

``security.sandbox`` decides; ``path_guard``'s SDK hook and the non-SDK
executor refuse before the write happens. Each refusal has its test.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from security.agent_safety_settings import ENV_VAR, SandboxSettings
from security.path_guard import make_write_path_hook
from security.sandbox import (
    SandboxPolicy,
    current_policy,
    path_allowed,
    project_relative,
    write_refusal,
)

RESTRICTED = SandboxPolicy(mode="restricted", allowed_paths=("src", "tests/unit"))


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    (root / "src").mkdir(parents=True)
    (root / ".workpilot" / "specs" / "001").mkdir(parents=True)
    return root


def test_normal_mode_refuses_nothing_inside_the_project(project: Path):
    assert write_refusal(SandboxPolicy(), "package.json", project) is None


@pytest.mark.parametrize(
    "target", ["src/app.py", "src/deep/x.ts", "tests/unit/a_test.go"]
)
def test_restricted_mode_allows_the_listed_paths(project: Path, target: str):
    assert write_refusal(RESTRICTED, target, project) is None


@pytest.mark.parametrize(
    "target", ["package.json", "srcx/app.py", "tests/e2e/a.spec.ts", "src/../setup.py"]
)
def test_restricted_mode_refuses_the_rest_of_the_project(project: Path, target: str):
    refusal = write_refusal(RESTRICTED, target, project)
    assert refusal is not None and "restricted mode" in refusal


def test_restricted_mode_keeps_the_build_state_writable(project: Path):
    spec = project / ".workpilot" / "specs" / "001"
    assert (
        write_refusal(RESTRICTED, str(spec / "implementation_plan.json"), project, spec)
        is None
    )
    # The project's own .workpilot folder is the build's state too.
    assert write_refusal(RESTRICTED, ".workpilot/notes.md", project) is None


def test_outside_the_project_is_left_to_the_write_roots(project: Path, tmp_path: Path):
    assert write_refusal(RESTRICTED, str(tmp_path / "elsewhere.txt"), project) is None


def test_a_file_over_the_size_limit_is_refused(project: Path):
    policy = SandboxPolicy(max_file_bytes=10)
    assert write_refusal(policy, "src/a.py", project, content_bytes=11) is not None
    assert write_refusal(policy, "src/a.py", project, content_bytes=10) is None
    # An edit's size is not known before it runs: left to the session watch.
    assert write_refusal(policy, "src/a.py", project, content_bytes=None) is None


def test_relative_paths_are_resolved_inside_the_project(project: Path):
    assert project_relative("src/./a/../b.py", project) == "src/b.py"
    assert project_relative("../x", project) is None
    assert path_allowed("src", ("src",)) and not path_allowed("srcx", ("src",))


def test_the_policy_comes_from_the_settings(monkeypatch):
    monkeypatch.setenv(
        ENV_VAR,
        json.dumps({"sandbox": {"mode": "restricted", "allowedPaths": ["lib/"]}}),
    )
    policy = current_policy()
    assert policy.restricted and policy.allowed_paths == ("lib",)
    settings = SandboxSettings(max_file_size_mb=1, max_session_minutes=2)
    policy = SandboxPolicy.from_settings(settings)
    assert policy.max_file_bytes == 1024 * 1024 and policy.max_session_seconds == 120


def _decision(hook, tool: str, tool_input: dict) -> str | None:
    out = asyncio.run(hook({"tool_name": tool, "tool_input": tool_input}))
    return out.get("hookSpecificOutput", {}).get("permissionDecision")


def test_the_sdk_hook_refuses_a_write_outside_the_restricted_paths(
    project, monkeypatch
):
    monkeypatch.setenv(
        ENV_VAR,
        json.dumps({"sandbox": {"mode": "restricted", "allowedPaths": ["src"]}}),
    )
    hook = make_write_path_hook(project)
    assert (
        _decision(
            hook, "Write", {"file_path": str(project / "setup.py"), "content": ""}
        )
        == "deny"
    )
    assert _decision(hook, "Edit", {"file_path": str(project / "src" / "a.py")}) is None


def test_the_sdk_hook_refuses_a_file_over_the_size_limit(project, monkeypatch):
    monkeypatch.setenv(ENV_VAR, json.dumps({"sandbox": {"maxFileSizeMb": 0.000001}}))
    hook = make_write_path_hook(project)
    big = {"file_path": str(project / "src" / "a.py"), "content": "x" * 64}
    assert _decision(hook, "Write", big) == "deny"


def test_the_non_sdk_executor_refuses_the_same_writes(project, monkeypatch):
    from core.runtimes.tool_executor import ToolExecutor

    monkeypatch.setenv(
        ENV_VAR,
        json.dumps({"sandbox": {"mode": "restricted", "allowedPaths": ["src"]}}),
    )
    executor = ToolExecutor(project_dir=project, agent_type="coder")
    with pytest.raises(ValueError, match="restricted mode"):
        executor._resolve_within_project("setup.py", for_write=True)
    assert executor._resolve_within_project("src/ok.py", for_write=True).name == "ok.py"
