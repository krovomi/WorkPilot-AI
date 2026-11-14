"""The Performance Profiler runner, as the desktop app starts it, on real code."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "performance_profiler_runner.py"
MARKER = "__PERF_RESULT__:"

NESTED = (
    "def triples(items):\n"
    "    out = []\n"
    "    for a in items:\n"
    "        for b in items:\n"
    "            for c in items:\n"
    "                out.append(a + b + c)\n"
    "    return out\n"
)
TIMER = "useEffect(() => {\n  setInterval(tick, 1000);\n}, []);\n"


def _run(project: Path, *args: str) -> tuple[int, list[str]]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
        check=False,
    )
    return done.returncode, done.stdout.splitlines()


def _result(lines: list[str]) -> dict:
    [line] = [ln for ln in lines if ln.startswith(MARKER)]
    return json.loads(line[len(MARKER) :])


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    (root / "cart.py").write_text(NESTED, encoding="utf-8")
    (root / "clock.tsx").write_text(TIMER, encoding="utf-8")
    return root


def test_bottlenecks_and_suggestions_are_reported(project: Path) -> None:
    code, lines = _run(project)
    assert code == 0
    result = _result(lines)
    assert result["status"] == "success"
    kinds = {b["type"] for b in result["report"]["bottlenecks"]}
    assert {"algorithm_complexity", "memory_leak"} <= kinds
    assert result["summary"]["top_issue"].startswith("cart.py: Nested loops")
    assert "implementation" not in result
    assert "   1 can be auto-implemented" in lines
    assert lines[-1] == "✅ Performance profiling complete!"


def test_auto_implement_queues_the_safe_fixes(project: Path) -> None:
    code, lines = _run(project, "--auto-implement", "--thinking-level", "low")
    assert code == 0
    assert "🔧 Auto-implementation enabled" in lines
    [queued] = _result(lines)["implementation"]
    assert queued["status"] == "queued" and queued["dry_run"] is False
    [line] = [ln for ln in lines if ln.startswith("__PERF_IMPLEMENTATION__:")]
    assert json.loads(line.split(":", 1)[1]) == [queued]
    assert "   ✅ Clear interval on unmount" in lines


def test_clean_code_has_no_top_issue(tmp_path: Path) -> None:
    (tmp_path / "ok.py").write_text("X = 1\n", encoding="utf-8")
    code, lines = _run(tmp_path)
    assert code == 0
    result = _result(lines)
    assert result["report"]["bottlenecks"] == []
    assert "top_issue" not in result["summary"]


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    code, lines = _run(tmp_path / "gone")
    assert code == 1
    assert lines == [f"❌ Project directory not found: {tmp_path / 'gone'}"]


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("perf_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_benchmark_failure_is_only_a_warning(runner, monkeypatch, project, capsys):
    def broken(self, timeout_seconds):
        raise RuntimeError("pytest-benchmark missing")

    monkeypatch.setattr(runner.BenchmarkRunner, "run_benchmarks", broken)
    result = runner.PerformanceProfilerRunner(str(project)).run_profiling()
    assert result["status"] == "success"
    assert "   ⚠️  Benchmark warning: pytest-benchmark missing" in (
        capsys.readouterr().out.splitlines()
    )


@pytest.mark.parametrize(
    ("error", "code", "last"),
    [
        (KeyboardInterrupt(), 1, "⚠️ Profiling interrupted."),
        (ValueError("bad file"), 1, None),
    ],
)
def test_a_stopped_run_says_so(runner, monkeypatch, project, capsys, error, code, last):
    def stop(self):
        raise error

    monkeypatch.setattr(runner.PerformanceProfilerRunner, "run_profiling", stop)
    monkeypatch.setattr(sys, "argv", ["r", "--project-dir", str(project)])
    with pytest.raises(SystemExit) as stopped:
        runner.main()
    assert stopped.value.code == code
    lines = capsys.readouterr().out.splitlines()
    if last:
        assert lines[-1] == last
    else:
        assert _result(lines) == {
            "status": "error",
            "error": "bad file",
            "report": None,
            "summary": {},
        }
