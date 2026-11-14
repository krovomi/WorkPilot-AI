"""Locating and running the pinned REA release (lot A).

A fake ``rea.mjs`` stands in for REA: it answers what ``answer.json`` beside it
says, so every outcome (report, exit 3, crash, no JSON, hang) is exercised
without the network. Node.js is the CI's own.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from foundation.platform import find_executable
from rea import COMMANDS, Pin, ReaLauncher, ReaUnavailable, load_pin, locate, run_rea
from rea.locate import installed_entry, npx_cli
from rea.pin import PinError, node_satisfies

NODE = find_executable("node")

FAKE_REA = """
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, "$1"));
const answer = JSON.parse(fs.readFileSync(path.join(here, "answer.json"), "utf8"));
const seen = { argv: process.argv.slice(2), cwd: process.cwd(),
  credential: process.env.ANTHROPIC_API_KEY ?? null };
fs.writeFileSync(path.join(here, "seen.json"), JSON.stringify(seen));
if (answer.sleep) await new Promise((r) => setTimeout(r, answer.sleep));
process.stdout.write(answer.stdout ?? "");
process.stderr.write(answer.stderr ?? "");
process.exit(answer.exit ?? 0);
"""

REPORT = {"checks": [{"id": "electron.run_as_node", "status": "exposed"}]}


@pytest.fixture
def fake_rea(tmp_path: Path):
    assert NODE, "Node.js runs REA; the CI has it"
    script = tmp_path / "fake" / "rea.mjs"
    script.parent.mkdir()
    script.write_text(FAKE_REA, encoding="utf-8")

    def answer(**kwargs) -> ReaLauncher:
        (script.parent / "answer.json").write_text(json.dumps(kwargs), encoding="utf-8")
        return ReaLauncher(
            argv=(NODE, str(script)),
            source="installed",
            node_version="22.23.4",
            version="6.9.0",
        )

    def seen() -> dict:
        return json.loads((script.parent / "seen.json").read_text(encoding="utf-8"))

    answer.seen = seen  # type: ignore[attr-defined]
    return answer


@pytest.fixture
def artifact(tmp_path: Path) -> Path:
    target = tmp_path / "dist" / "app"
    target.mkdir(parents=True)
    return target


# --- the pin ---------------------------------------------------------------


def test_the_shipped_pin_is_one_exact_release():
    pin = load_pin()
    assert pin.package == "rea-agents"
    assert pin.spec == f"rea-agents@{pin.version}"
    assert all(part.isdigit() for part in pin.version.split("."))


@pytest.mark.parametrize(
    "content",
    [
        {"package": "rea", "version": "6.9.0", "node": [">=22.0.0"]},
        {"package": "rea-agents", "version": "latest", "node": [">=22.0.0"]},
        {"package": "rea-agents", "version": "^6.9.0", "node": [">=22.0.0"]},
        {"package": "rea-agents", "version": "6.9.0", "node": []},
        {"package": "rea-agents", "version": "6.9.0", "node": ["22"]},
    ],
)
def test_a_pin_that_is_not_one_exact_release_is_refused(tmp_path: Path, content):
    path = tmp_path / "pin.json"
    path.write_text(json.dumps(content), encoding="utf-8")
    with pytest.raises(PinError):
        load_pin(path)


@pytest.mark.parametrize(
    ("version", "expected"),
    [
        ("v22.23.4", True),
        ("22.40.0", True),
        ("v22.12.0", False),
        ("v23.9.0", False),
        ("v24.22.1", True),
        ("v24.1.0", False),
        ("v26.12.1", True),
        ("v30.0.0", True),
        ("garbage", False),
    ],
)
def test_node_ranges_read_like_the_release_script(version: str, expected: bool):
    assert node_satisfies(version, ("^22.23.4", "^24.22.1", ">=26.12.1")) is expected


# --- locating it -----------------------------------------------------------


def _package(root: Path, version: str) -> Path:
    entry = root / "rea-agents" / "scripts" / "rea.mjs"
    entry.parent.mkdir(parents=True)
    entry.write_text("", encoding="utf-8")
    (root / "rea-agents" / "package.json").write_text(
        json.dumps({"name": "rea-agents", "version": version}), encoding="utf-8"
    )
    return entry


PIN = Pin(package="rea-agents", version="6.9.0", node=("^22.23.4", ">=24.0.0"))


def test_the_windows_launcher_leads_to_the_package_beside_it(tmp_path: Path):
    entry = _package(tmp_path / "npm" / "node_modules", "6.9.0")
    launcher = tmp_path / "npm" / "rea.cmd"
    launcher.write_text("@node ...", encoding="utf-8")
    assert installed_entry(str(launcher), PIN) == entry


def test_the_posix_symlink_is_followed_to_the_package(tmp_path: Path):
    entry = _package(tmp_path / "lib" / "node_modules", "6.9.0")
    link = tmp_path / "bin" / "rea"
    link.parent.mkdir()
    try:
        link.symlink_to(entry)
    except OSError:  # Windows without the symlink right: what the link resolves to
        link = entry
    assert installed_entry(str(link), PIN) == entry.resolve()


def test_another_installed_version_is_not_used(tmp_path: Path):
    _package(tmp_path / "npm" / "node_modules", "6.8.0")
    launcher = tmp_path / "npm" / "rea.cmd"
    launcher.write_text("", encoding="utf-8")
    assert installed_entry(str(launcher), PIN) is None


def test_npx_is_found_in_either_layout(tmp_path: Path):
    windows = tmp_path / "win"
    (windows / "node_modules" / "npm" / "bin").mkdir(parents=True)
    (windows / "node_modules" / "npm" / "bin" / "npx-cli.js").write_text(
        "", encoding="utf-8"
    )
    assert npx_cli(str(windows / "node.exe")) is not None
    posix = tmp_path / "posix"
    (posix / "lib" / "node_modules" / "npm" / "bin").mkdir(parents=True)
    (posix / "lib" / "node_modules" / "npm" / "bin" / "npx-cli.js").write_text(
        "", encoding="utf-8"
    )
    (posix / "bin").mkdir()
    assert npx_cli(str(posix / "bin" / "node")) is not None
    assert npx_cli(str(tmp_path / "nowhere" / "node")) is None


def test_without_node_rea_is_unavailable(tmp_path: Path):
    found = locate(PIN, node=str(tmp_path / "no-node"), installs=())
    assert isinstance(found, ReaUnavailable)
    assert found.reason == "node_missing"


def test_a_node_older_than_the_pin_is_reported():
    assert NODE
    pin = Pin(package="rea-agents", version="6.9.0", node=(">=99.0.0",))
    found = locate(pin, node=NODE, installs=())
    assert isinstance(found, ReaUnavailable)
    assert found.reason == "node_too_old"


def test_an_installed_pinned_release_is_preferred_to_npx(tmp_path: Path):
    assert NODE
    entry = _package(tmp_path / "npm" / "node_modules", "6.9.0")
    launcher = tmp_path / "npm" / "rea.cmd"
    launcher.write_text("", encoding="utf-8")
    pin = Pin(package="rea-agents", version="6.9.0", node=(">=1.0.0",))
    found = locate(pin, node=NODE, rea=str(launcher))
    assert isinstance(found, ReaLauncher)
    assert found.source == "installed"
    assert found.argv == (NODE, str(entry))


def test_strict_offline_never_downloads():
    assert NODE
    pin = Pin(package="rea-agents", version="6.9.0", node=(">=1.0.0",))
    found = locate(pin, allow_download=False, node=NODE, rea="")
    assert isinstance(found, ReaUnavailable)
    assert found.reason == "offline"


def test_npx_fetches_exactly_the_pinned_release():
    assert NODE
    pin = Pin(package="rea-agents", version="6.9.0", node=(">=1.0.0",))
    found = locate(pin, node=NODE, rea="")
    if isinstance(found, ReaUnavailable):
        assert found.reason == "npx_missing"  # a Node.js packaged without npm
        return
    assert found.downloads
    assert found.argv[-2:] == ("--yes", "rea-agents@6.9.0")


# --- running it ------------------------------------------------------------


def test_the_report_comes_back_as_data(fake_rea, artifact: Path):
    launcher = fake_rea(
        stdout=json.dumps({"evidence_id": "ev_1", "normalized_result": REPORT}), exit=0
    )
    run = run_rea("audit-release-exposure", [artifact], launcher=launcher)
    assert run.ok and run.exit_code == 0
    assert run.result == REPORT
    assert run.evidence_id == "ev_1"
    assert fake_rea.seen()["argv"] == [
        "audit-release-exposure",
        str(artifact.resolve()),
        "--json",
    ]


def test_a_met_fail_on_is_an_answer_not_a_failure(fake_rea, artifact: Path):
    launcher = fake_rea(stdout=json.dumps({"normalized_result": REPORT}), exit=3)
    run = run_rea(
        "audit-release-exposure", [artifact], {"--fail_on": "high"}, launcher=launcher
    )
    assert run.ok and run.exit_code == 3
    assert fake_rea.seen()["argv"][2:4] == ["--fail_on", "high"]


def test_a_crash_is_a_failure_with_its_stderr(fake_rea, artifact: Path):
    launcher = fake_rea(stdout="", stderr="boom: provider failed", exit=1)
    run = run_rea("inspect-binary-hardening", [artifact], launcher=launcher)
    assert not run.ok and run.error == "failed"
    assert "boom" in run.detail


def test_output_without_json_is_not_a_result(fake_rea, artifact: Path):
    launcher = fake_rea(stdout="Usage: rea …", exit=0)
    run = run_rea("inspect-electron-fuses", [artifact], launcher=launcher)
    assert not run.ok and run.error == "bad_output"


def test_a_hang_is_stopped(fake_rea, artifact: Path):
    launcher = fake_rea(stdout="{}", sleep=20_000)
    run = run_rea("inspect-electron-fuses", [artifact], launcher=launcher, timeout=2)
    assert not run.ok and run.error == "timeout"


def test_rea_runs_without_credentials_from_a_directory_of_its_own(
    fake_rea, artifact: Path, monkeypatch, tmp_path: Path
):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-0000")
    monkeypatch.chdir(tmp_path)
    launcher = fake_rea(stdout=json.dumps({"normalized_result": REPORT}))
    run_rea("inspect-electron-fuses", [artifact], launcher=launcher)
    seen = fake_rea.seen()
    assert seen["credential"] is None
    assert Path(seen["cwd"]).resolve() != tmp_path.resolve()
    assert not Path(seen["cwd"]).exists(), "its working directory is removed"


@pytest.mark.parametrize(
    ("command", "paths", "options"),
    [
        ("capture-process", ["ABS"], {}),
        ("environment-build", ["ABS"], {}),
        ("audit-release-exposure", ["relative/path"], {}),
        ("audit-release-exposure", ["MISSING"], {}),
        ("audit-release-exposure", ["ABS", "ABS"], {}),
        ("audit-release-exposure", ["ABS"], {"--fail_on": "info"}),
        ("audit-release-exposure", ["ABS"], {"--max-file-bytes": "1"}),
        ("inspect-binary-hardening", ["ABS"], {"--fail_on": "high"}),
        ("compare-managed-members", ["ABS"], {}),
    ],
)
def test_anything_outside_the_closed_lists_is_refused(
    fake_rea, artifact: Path, command, paths, options
):
    launcher = fake_rea(stdout="{}")
    concrete = [
        str(artifact)
        if p == "ABS"
        else str(artifact.parent / "missing")
        if p == "MISSING"
        else p
        for p in paths
    ]
    run = run_rea(command, concrete, options, launcher=launcher)
    assert not run.ok and run.error == "refused", run
    assert not (Path(launcher.argv[1]).parent / "seen.json").exists(), "REA never ran"


def test_only_static_readers_are_listed():
    runtime = {
        "capture",
        "browser",
        "adb",
        "frida",
        "gdb",
        "environment",
        "push",
        "run",
    }
    for command in COMMANDS:
        assert not any(word in command.split("-") for word in runtime), command


def test_an_unavailable_rea_says_why(artifact: Path):
    missing = ReaUnavailable("node_missing", "Node.js is not on PATH")
    run = run_rea("inspect-electron-fuses", [artifact], launcher=missing)
    assert not run.ok and run.error == "unavailable"
    assert run.unavailable is missing


def test_a_strict_offline_project_only_runs_an_installed_rea(
    monkeypatch, artifact: Path, tmp_path: Path
):
    project = tmp_path / "project"
    (project / ".workpilot").mkdir(parents=True)
    (project / ".workpilot" / "offline-mode.json").write_text(
        json.dumps({"airgapStrict": True}), encoding="utf-8"
    )
    asked: list[bool] = []

    def fake_locate(pin, *, allow_download=True, **_):
        asked.append(allow_download)
        return ReaUnavailable("offline", "not installed")

    monkeypatch.setattr("rea.runner.locate", fake_locate)
    run = run_rea("inspect-electron-fuses", [artifact], project_dir=project)
    assert asked == [False]
    assert run.error == "unavailable"


def test_no_stray_temp_directories(
    fake_rea, artifact: Path, tmp_path: Path, monkeypatch
):
    base = tmp_path / "tmp"
    base.mkdir()
    monkeypatch.setenv("TMPDIR", str(base))
    monkeypatch.setenv("TEMP", str(base))
    monkeypatch.setenv("TMP", str(base))
    import tempfile

    monkeypatch.setattr(tempfile, "tempdir", None)
    launcher = fake_rea(stdout=json.dumps({"normalized_result": REPORT}))
    run_rea("inspect-electron-fuses", [artifact], launcher=launcher)
    assert list(base.iterdir()) == []
    shutil.rmtree(base)
