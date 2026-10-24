"""QA runs `dotnet test` without blocking the event loop, and a failing
suite reaches the reviewer instead of being reported as "executed"."""

from __future__ import annotations

import asyncio
import sys

import pytest
from qa import loop as qa_loop

_real_exec = asyncio.create_subprocess_exec

TEST_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="xunit" /></ItemGroup></Project>'


def _fake_dotnet(monkeypatch, exit_code: int, output: str = ""):
    calls: list[tuple] = []

    async def fake(program, *args, **kwargs):
        calls.append((program, *args))
        code = f"import sys; sys.stdout.write({output!r}); sys.exit({exit_code})"
        return await _real_exec(sys.executable, "-c", code, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake)
    return calls


@pytest.fixture
def dotnet_project(tmp_path):
    (tmp_path / "App.Tests").mkdir()
    (tmp_path / "App.Tests" / "App.Tests.csproj").write_text(
        TEST_CSPROJ, encoding="utf-8"
    )
    return tmp_path


def test_a_green_suite_passes(dotnet_project, monkeypatch):
    calls = _fake_dotnet(monkeypatch, 0)

    run = asyncio.run(qa_loop._run_dotnet_tests(dotnet_project))

    assert run.status == "passed"
    assert calls[0][:2] == ("dotnet", "test")
    assert qa_loop.dotnet_test_advice(run, dotnet_project) == ""


def test_a_red_suite_fails_and_tells_the_reviewer(
    dotnet_project, monkeypatch, tmp_path
):
    _fake_dotnet(monkeypatch, 1, "Failed AppTests.Adds [12 ms]")

    run = asyncio.run(qa_loop._run_dotnet_tests(dotnet_project))

    assert run.status == "failed"
    assert "Failed AppTests.Adds" in run.detail
    advice = qa_loop.dotnet_test_advice(run, tmp_path)
    assert "dotnet test failed" in advice
    assert "Failed AppTests.Adds" in advice


def test_no_test_project_is_unavailable(tmp_path):
    run = asyncio.run(qa_loop._run_dotnet_tests(tmp_path))

    assert run.status == "unavailable"


def test_a_missing_dotnet_cli_is_unavailable(dotnet_project, monkeypatch):
    async def missing(*args, **kwargs):
        raise FileNotFoundError("dotnet")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", missing)

    run = asyncio.run(qa_loop._run_dotnet_tests(dotnet_project))

    assert run.status == "unavailable"
