"""The Browser Agent runner, started the way the desktop app starts it.

Baselines, comparisons, the dashboard and the test run go through the real
command on real PNG files. Taking a screenshot needs a Chromium, which the
CI does not install for Python: the command's failure without one is checked
for real, and its success with a stand-in browser, in-process.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "browser_agent_runner.py"


def _shots(project: Path) -> Path:
    folder = project / ".workpilot" / "browser-agent" / "screenshots"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _png(path: Path, color: tuple[int, int, int], size=(40, 30)) -> Path:
    Image.new("RGB", size, color).save(path)
    return path


def _run(project: Path, *args: str, env: dict | None = None):
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, **(env or {})},
        timeout=120,
        check=False,
    )
    return done.returncode, done.stdout, done.stderr


def _json(project: Path, *args: str, env: dict | None = None):
    code, out, err = _run(project, "--json", *args, env=env)
    return code, json.loads(out), err


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "site"
    _png(_shots(root) / "home_20261114_120000.png", (255, 255, 255))
    return root


def test_a_baseline_is_set_listed_compared_and_deleted(project: Path) -> None:
    code, out, _ = _run(project, "baseline", "set", "--name", "home")
    assert code == 0
    assert "✅ Baseline set for 'home'" in out
    assert "  width: 40" in out and "  height: 30" in out

    code, result, _ = _json(project, "baseline", "list")
    assert code == 0
    [baseline] = result["data"]
    assert (baseline["name"], baseline["width"], baseline["height"]) == ("home", 40, 30)
    code, out, _ = _run(project, "baseline", "list")
    assert "📋 1 baseline(s):" in out and "  - home (40x30) created " in out

    code, result, _ = _json(project, "compare", "--name", "home")
    assert code == 0 and result["data"]["passed"] is True
    assert result["data"]["matchPercentage"] == 100.0
    code, out, _ = _run(project, "compare", "--name", "home")
    assert "✅ Match: 100.0% (threshold: 95.0%)" in out
    assert "Diff pixels" not in out

    code, out, _ = _run(project, "baseline", "delete", "--name", "home")
    assert code == 0 and "🗑️ Baseline 'home' deleted." in out
    code, out, err = _run(project, "baseline", "delete", "--name", "home")
    assert "No baseline found for 'home'." in out
    assert err.strip() == "Error: Unknown error"
    code, out, _ = _run(project, "baseline", "list")
    assert "No baselines found." in out


def test_a_changed_page_fails_the_comparison_with_a_diff_image(project: Path):
    _run(project, "baseline", "set", "--name", "home")
    newer = _png(_shots(project) / "home_20261114_130000.png", (0, 0, 0))
    os.utime(newer, (newer.stat().st_atime + 60, newer.stat().st_mtime + 60))

    code, out, _ = _run(project, "compare", "--name", "home")
    assert code == 0
    assert "❌ Match: 0.0% (threshold: 95.0%)" in out
    assert "   Diff pixels: 1200" in out
    assert "   Diff image: " in out
    code, result, _ = _json(project, "compare", "--name", "home")
    assert result["data"]["passed"] is False
    assert Path(result["data"]["diffImagePath"]).is_file()


def test_a_baseline_from_an_explicit_screenshot(project: Path) -> None:
    other = _png(_shots(project) / "cart_20261114_120000.png", (10, 20, 30))
    code, result, _ = _json(
        project, "baseline", "set", "--name", "cart", "--screenshot", str(other)
    )
    assert code == 0 and result["data"]["name"] == "cart"
    assert Path(result["data"]["path"]).name == "cart.png"


def test_options_in_the_form_the_desktop_app_sends(project: Path) -> None:
    # The app passes each value glued to its option, as `--name=<value>`.
    other = _png(_shots(project) / "cart_20261114_120000.png", (10, 20, 30))
    done = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            f"--project={project}",
            "--json",
            "baseline",
            "set",
            "--name=cart",
            f"--screenshot={other}",
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["data"]["name"] == "cart"
    code, result, _ = _json(project, "compare", "--name=cart")
    assert code == 0 and result["data"]["passed"] is True


def test_nothing_to_compare_or_promote_without_a_screenshot(project: Path) -> None:
    code, result, _ = _json(project, "compare", "--name", "login")
    assert code == 0
    assert result == {
        "success": False,
        "error": "No screenshot found for 'login'. Capture one first.",
    }
    code, out, err = _run(project, "baseline", "set", "--name", "login")
    assert out == "" and err.strip() == "Error: No screenshot found for 'login'."


def test_a_missing_screenshot_file_is_an_error(project: Path) -> None:
    gone = str(project / "gone.png")
    code, result, _ = _json(
        project, "baseline", "set", "--name", "x", "--screenshot", gone
    )
    assert code == 1
    assert result == {"success": False, "error": f"Screenshot not found: {gone}"}
    code, out, err = _run(
        project, "baseline", "set", "--name", "x", "--screenshot", gone
    )
    assert code == 1 and err.strip() == f"Error: Screenshot not found: {gone}"


def test_the_dashboard_counts_tests_screenshots_and_baselines(project: Path) -> None:
    e2e = project / "e2e"
    e2e.mkdir()
    (e2e / "login.spec.ts").write_text("test('x', () => {})\n", encoding="utf-8")
    _run(project, "baseline", "set", "--name", "home")

    code, out, _ = _run(project, "dashboard")
    assert code == 0
    assert out.splitlines() == [
        "🌐 Browser Agent Dashboard",
        "  Tests discovered: 1",
        "  Screenshots: 1",
        "  Baselines: 1",
    ]
    code, result, _ = _json(project, "dashboard")
    data = result["data"]
    assert data["stats"]["totalTests"] == 1
    assert [s["name"] for s in data["screenshots"]] == ["home"]
    assert data["comparisons"] == [] and data["recentTestRun"] is None


def test_a_project_without_e2e_tests_runs_none(tmp_path: Path) -> None:
    code, out, _ = _run(tmp_path, "tests")
    assert code == 0
    assert "Results: 0 passed, 0 failed, 0 skipped" in out
    assert "Duration: 0ms" in out
    code, result, _ = _json(tmp_path, "tests", "--files", "e2e/a.spec.ts")
    assert result["data"]["total"] == 0


def test_without_a_browser_the_screenshot_fails_cleanly(tmp_path: Path) -> None:
    no_browsers = {"PLAYWRIGHT_BROWSERS_PATH": str(tmp_path / "no-browsers")}
    args = ("screenshot", "--url", "http://127.0.0.1:9/", "--name", "home")
    code, result, _ = _json(tmp_path, *args, env=no_browsers)
    assert code == 1 and result["success"] is False and result["error"]
    code, out, err = _run(tmp_path, *args, env=no_browsers)
    assert code == 1
    assert out.startswith("📸 Capturing screenshot of http://127.0.0.1:9/...")
    assert err.startswith("Error: ")


def test_help_without_a_command_and_a_missing_project(tmp_path: Path) -> None:
    code, out, _ = _run(tmp_path)
    assert code == 0 and "screenshot" in out and "dashboard" in out
    code, out, _ = _run(tmp_path, "baseline")
    assert code == 0 and "{set,list,delete}" in out
    code, _, err = _run(tmp_path / "gone", "dashboard")
    assert code == 1 and err.startswith("Error: Project directory not found:")


# --- in-process: a screenshot with a stand-in browser ----------------------------


class StandInBrowser:
    """Writes the PNG a real browser would, and records launch and close."""

    events: list[str] = []

    def __init__(self, project: Path) -> None:
        self.project = project

    async def launch(self) -> None:
        self.events.append("launch")

    async def screenshot(self, name: str, url: str, full_page: bool = False):
        from browser_agent.models import ScreenshotInfo

        self.events.append(f"shot {name} {url} full={full_page}")
        path = _png(_shots(self.project) / f"{name}_20261114_140000.png", (0, 0, 0))
        return ScreenshotInfo(
            name=name, path=str(path), url=url, timestamp="t", width=40, height=30
        )

    async def close(self) -> None:
        self.events.append("close")


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch, project: Path):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("browser_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    StandInBrowser.events = []
    monkeypatch.setattr(
        module.BrowserAgentRunner,
        "_get_controller",
        lambda self: StandInBrowser(self.project_dir),
    )
    return module


def _main(runner, monkeypatch, project: Path, *args: str) -> None:
    monkeypatch.setattr(sys, "argv", ["runner", "--project", str(project), *args])
    runner.main()


def test_a_screenshot_is_taken_and_the_browser_closed(
    runner, monkeypatch, project: Path, capsys
) -> None:
    _main(
        runner,
        monkeypatch,
        project,
        "screenshot",
        "--url",
        "http://localhost:3000",
        "--name",
        "home",
        "--full-page",
    )
    out = capsys.readouterr().out
    assert "✅ Screenshot saved: " in out and "home_20261114_140000.png" in out
    assert StandInBrowser.events == [
        "launch",
        "shot home http://localhost:3000 full=True",
        "close",
    ]


def test_compare_with_a_url_captures_a_fresh_screenshot(
    runner, monkeypatch, project: Path, capsys
) -> None:
    _run(project, "baseline", "set", "--name", "home")
    _main(
        runner,
        monkeypatch,
        project,
        "--json",
        "compare",
        "--name",
        "home",
        "--url",
        "http://localhost:3000",
    )
    result = json.loads(capsys.readouterr().out)
    assert result["data"]["passed"] is False
    assert StandInBrowser.events == [
        "launch",
        "shot home http://localhost:3000 full=False",
        "close",
    ]
