"""`--env-*` and `--browser-agent`: what each mode does and prints."""

from __future__ import annotations

import pytest
from cli import browser_agent_commands as bac
from cli import env_commands as ec
from environment.capturer import EnvironmentCapture, EnvironmentCapturer, ServiceCapture
from environment.validator import EnvironmentValidator, ValidationResult

COMPOSE = """\
services:
  db:
    image: postgres:16
    ports:
      - "5433:5432"
  worker:
    build: .
networks:
  back: {}
"""


@pytest.fixture
def no_containers(monkeypatch):
    calls = []

    def capture(self, prefix=""):
        calls.append(prefix)
        return EnvironmentCapture(project_name="p", source="running_containers")

    monkeypatch.setattr(EnvironmentCapturer, "capture_from_running_containers", capture)
    return calls


def test_capture_then_reproduce_from_the_compose_file(tmp_path, capsys, no_containers):
    (tmp_path / "docker-compose.yml").write_text(COMPOSE, encoding="utf-8")
    (tmp_path / ".env").write_text("PORT=8080\nDB_PASSWORD=x\n", encoding="utf-8")

    ec.handle_env_capture_command(tmp_path)
    out = capsys.readouterr().out

    saved = tmp_path / ".workpilot" / "environment" / "environment_capture.json"
    assert saved.is_file()
    assert no_containers == []
    assert "Captured 2 services:" in out
    assert "  - db (postgres:16) ports=5433:5432" in out
    assert "  - worker\n" in out
    assert "Captured 2 environment variables" in out
    assert f"Saved to: {saved}" in out

    ec.handle_env_reproduce_command(tmp_path)
    out = capsys.readouterr().out

    env_dir = tmp_path / ".workpilot" / "environment"
    compose = env_dir / "docker-compose.clone.yml"
    assert "postgres:16" in compose.read_text(encoding="utf-8")
    assert "<REPLACE_ME>" in (env_dir / ".env.clone").read_text(encoding="utf-8")
    assert f"  - {compose}" in out
    assert (
        f"docker compose -f {compose} --env-file {env_dir / '.env.clone'} up -d" in out
    )


def test_without_compose_file_auto_tries_the_running_containers(
    tmp_path, capsys, no_containers
):
    ec.handle_env_capture_command(tmp_path)
    out = capsys.readouterr().out
    assert no_containers == [""]
    assert "trying running containers" in out
    assert "No services detected" in out
    assert not (tmp_path / ".workpilot").exists()


def test_compose_source_does_not_fall_back(tmp_path, capsys, no_containers):
    ec.handle_env_capture_command(tmp_path, source="compose")
    assert no_containers == []
    assert "No services detected" in capsys.readouterr().out


def test_containers_source_reads_only_the_containers(tmp_path, capsys, monkeypatch):
    (tmp_path / "docker-compose.yml").write_text(COMPOSE, encoding="utf-8")

    def capture(self, prefix=""):
        return EnvironmentCapture(
            project_name="p",
            services=[ServiceCapture(name="cache", image="")],
            source="running_containers",
        )

    monkeypatch.setattr(EnvironmentCapturer, "capture_from_running_containers", capture)

    ec.handle_env_capture_command(tmp_path, source="containers")

    out = capsys.readouterr().out
    assert "Captured 1 services:\n  - cache\n" in out
    assert "environment variables" not in out


def test_reproduce_without_a_capture(tmp_path, capsys):
    ec.handle_env_reproduce_command(tmp_path)
    assert "No capture found. Run --env-capture first." in capsys.readouterr().out


def test_validate_without_a_cloned_environment_fails(tmp_path, capsys):
    ec.handle_env_validate_command(tmp_path)
    out = capsys.readouterr().out
    assert "Errors: Compose file not found: docker-compose.clone.yml" in out
    assert out.rstrip().endswith("Validation FAILED")


def test_validate_reports_services_and_ports(tmp_path, capsys, monkeypatch):
    seen = {}

    def validate(self, timeout=60):
        seen["timeout"] = timeout
        return ValidationResult(
            success=True,
            services_up=["db", "web"],
            services_down=["worker"],
            port_checks={"db:5433": True, "web:80": False},
        )

    monkeypatch.setattr(EnvironmentValidator, "validate", validate)

    ec.handle_env_validate_command(tmp_path)

    out = capsys.readouterr().out
    assert seen == {"timeout": 30}
    assert "Services UP: db, web" in out
    assert "Services DOWN: worker" in out
    assert "  db:5433: OK\n  web:80: FAIL" in out
    assert "Errors" not in out
    assert out.rstrip().endswith("Validation PASSED")


# --- browser agent ---------------------------------------------------------


class _Browser:
    calls: list = []
    result: dict = {}

    def __init__(self, project_dir):
        self.project_dir = project_dir

    async def run_screenshot(self, url, name):
        self.calls.append(("screenshot", url, name))
        return self.result

    async def run_compare(self, name, url):
        self.calls.append(("compare", name, url))
        return self.result

    def run_tests(self):
        self.calls.append(("tests",))
        return self.result


@pytest.fixture
def browser(monkeypatch):
    from runners import browser_agent_runner

    _Browser.calls = []
    _Browser.result = {"success": False}
    monkeypatch.setattr(browser_agent_runner, "BrowserAgentRunner", _Browser)
    return _Browser


@pytest.mark.parametrize(
    ("mode", "kwargs", "needed"),
    [
        ("screenshot", {"name": "home"}, "--browser-url"),
        ("screenshot", {"url": "http://localhost:3000"}, "--browser-name"),
        ("compare", {"url": "http://localhost:3000"}, "--browser-name"),
    ],
)
def test_a_mode_without_its_argument_is_refused(
    tmp_path, browser, capsys, mode, kwargs, needed
):
    with pytest.raises(SystemExit) as stop:
        bac.handle_browser_agent_command(tmp_path, mode, **kwargs)
    assert stop.value.code == 1
    assert f"{needed} is required for {mode} mode" in capsys.readouterr().out
    assert browser.calls == []


def test_screenshot(tmp_path, browser, capsys):
    browser.result = {"success": True, "data": {"path": "shots/home.png"}}
    bac.handle_browser_agent_command(
        tmp_path, "screenshot", url="http://localhost:3000", name="home"
    )
    assert browser.calls == [("screenshot", "http://localhost:3000", "home")]
    assert "Screenshot saved: shots/home.png" in capsys.readouterr().out


@pytest.mark.parametrize("passed", [True, False])
def test_compare(tmp_path, browser, capsys, passed):
    browser.result = {
        "success": True,
        "data": {"passed": passed, "matchPercentage": 97.5, "threshold": 99},
    }
    bac.handle_browser_agent_command(tmp_path, "compare", name="home")
    out = capsys.readouterr().out
    assert browser.calls == [("compare", "home", None)]
    assert ("✅" if passed else "❌") + " Match: 97.5% (threshold: 99%)" in out


def test_tests(tmp_path, browser, capsys):
    browser.result = {"success": True, "data": {"passed": 3, "failed": 1, "skipped": 2}}
    bac.handle_browser_agent_command(tmp_path, "tests")
    assert "Results: 3 passed, 1 failed, 2 skipped" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("mode", "kwargs"),
    [
        ("screenshot", {"url": "http://x", "name": "n"}),
        ("compare", {"name": "n"}),
        ("tests", {}),
    ],
)
def test_a_failed_run_exits_with_its_error(tmp_path, browser, capsys, mode, kwargs):
    browser.result = {"success": False, "error": "browser not installed"}
    with pytest.raises(SystemExit):
        bac.handle_browser_agent_command(tmp_path, mode, **kwargs)
    assert "❌ browser not installed" in capsys.readouterr().out


def test_the_dashboard_of_an_empty_project(tmp_path, capsys):
    bac.handle_browser_agent_command(tmp_path, "dashboard")
    out = capsys.readouterr().out
    assert "Browser Agent Dashboard" in out
    assert "  Tests discovered: 0\n  Screenshots: 0\n  Baselines: 0" in out


def test_an_unknown_browser_mode(tmp_path, browser, capsys):
    with pytest.raises(SystemExit):
        bac.handle_browser_agent_command(tmp_path, "record")
    assert (
        "Valid modes: screenshot, compare, tests, dashboard" in capsys.readouterr().out
    )
