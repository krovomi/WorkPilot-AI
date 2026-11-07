"""hermes 0.23: which release is installed, and the features WorkPilot wires.

* the doctor names the installed release and asks for ``hermes update`` below
  0.23.0 — and says nothing when it cannot tell, because "unknown" is not
  "too old";
* installing the persona asks running sessions to rebuild their prompt
  (``hermes sessions refresh-prompts``), on the same home it wrote into;
* the hermes skills pack follows upstream *releases*, not its default branch.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from hermes import readiness, soul, version  # noqa: E402
from hermes.readiness import doctor  # noqa: E402
from hermes.version import (  # noqa: E402
    MIN_VERSION,
    installed_version,
    parse_version,
    satisfies,
)
from skills_registry import upstream  # noqa: E402

# What `hermes --version` printed for v0.23.0, verbatim but the paths.
REAL_0_23 = (
    "Hermes Agent v0.23.0 (2026.9.24)\n"
    "Install directory: /home/me/.hermes/hermes-agent\n"
    "Python: 3.12.3\n"
    "OpenAI SDK: Not installed\n"
)


@pytest.fixture(autouse=True)
def _fresh_cache():
    version._cache.clear()
    yield
    version._cache.clear()


@pytest.fixture
def fake_binary(tmp_path: Path) -> Path:
    path = tmp_path / "bin" / "hermes"
    path.parent.mkdir()
    path.write_text("#!/bin/sh\n", encoding="utf-8")
    return path


def _completed(stdout: str, code: int = 0):
    return subprocess.CompletedProcess(
        args=[], returncode=code, stdout=stdout, stderr=""
    )


class TestParsing:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            (REAL_0_23, "0.23.0"),
            ("Hermes Agent v0.23.0+12.gabc1234 · stable\n", "0.23.0"),
            ("Hermes Agent v0.22.7 (2026.9.24)\n", "0.22.7"),
            # A source checkout without its tags: no release, and the
            # Python line below must not be read as one.
            ("Hermes Agent vgit.af5c201 (2026.9.24)\nPython: 3.12.3\n", None),
            ("", None),
        ],
    )
    def test_the_release_is_read_from_the_hermes_line_only(self, text, expected):
        assert parse_version(text) == expected

    def test_the_comparison_is_numeric(self):
        assert satisfies("0.23.0") is True
        assert satisfies("0.100.0") is True
        assert satisfies("0.22.9") is False
        assert satisfies(None) is None

    def test_the_minimum_is_the_release_whose_features_are_wired(self):
        assert MIN_VERSION == "0.23.0"


class TestProbe:
    def test_runs_hermes_version_once_per_binary(self, fake_binary, monkeypatch):
        calls: list[list[str]] = []

        def run(cmd, **kwargs):
            calls.append(cmd)
            assert kwargs["timeout"] <= 10 and kwargs["stdin"] is subprocess.DEVNULL
            return _completed(REAL_0_23)

        monkeypatch.setattr(version.subprocess, "run", run)
        assert installed_version(str(fake_binary)) == "0.23.0"
        assert installed_version(str(fake_binary)) == "0.23.0"
        assert len(calls) == 1 and calls[0][1:] == ["--version"]

    def test_a_miss_is_asked_again(self, fake_binary, monkeypatch):
        answers = [subprocess.TimeoutExpired("hermes", 10), _completed(REAL_0_23)]

        def run(cmd, **kwargs):
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer

        monkeypatch.setattr(version.subprocess, "run", run)
        assert installed_version(str(fake_binary)) is None
        assert installed_version(str(fake_binary)) == "0.23.0"

    def test_no_binary_no_subprocess(self, monkeypatch):
        monkeypatch.setattr(version.subprocess, "run", pytest.fail)
        assert installed_version(None) is None
        assert installed_version("/does/not/exist/hermes") is None


class TestDoctor:
    @pytest.fixture
    def home(self, tmp_path: Path) -> Path:
        root = tmp_path / "hermes-home"
        root.mkdir()
        return root

    def _with(self, monkeypatch, fake_binary, stdout: str, code: int = 0):
        monkeypatch.setattr(readiness, "_executable", lambda: str(fake_binary))
        monkeypatch.setattr(
            version.subprocess, "run", lambda cmd, **kw: _completed(stdout, code)
        )

    def _check(self, report, name):
        return next((c for c in report.checks if c.name == name), None)

    def test_a_current_hermes_passes(self, monkeypatch, fake_binary, home):
        self._with(monkeypatch, fake_binary, REAL_0_23)
        report = doctor(REPO_ROOT, home=home, probe_version=True)
        check = self._check(report, "version")
        assert check.ok and check.detail == "hermes 0.23.0" and not check.remedy
        assert report.to_dict()["version"] == "0.23.0"
        assert report.to_dict()["minVersion"] == MIN_VERSION

    def test_an_older_hermes_is_asked_to_update(self, monkeypatch, fake_binary, home):
        self._with(monkeypatch, fake_binary, "Hermes Agent v0.22.7 (x)\n")
        report = doctor(REPO_ROOT, home=home, probe_version=True)
        check = self._check(report, "version")
        assert not check.ok and not check.required
        assert check.remedy == "hermes update"
        assert "0.22.7" in check.detail
        assert report.ready, "an old hermes still runs the loop"

    def test_an_unreadable_version_is_not_reported(
        self, monkeypatch, fake_binary, home
    ):
        self._with(monkeypatch, fake_binary, "Hermes Agent vgit.abc (x)\n")
        report = doctor(REPO_ROOT, home=home, probe_version=True)
        assert self._check(report, "version") is None
        assert report.version is None

    def test_the_build_never_runs_hermes(self, monkeypatch, fake_binary, home):
        monkeypatch.setattr(readiness, "_executable", lambda: str(fake_binary))
        monkeypatch.setattr(version.subprocess, "run", pytest.fail)
        report = doctor(REPO_ROOT, home=home)
        assert self._check(report, "version") is None

    def test_the_status_panel_asks_for_it(self):
        api = (REPO_ROOT / "apps" / "backend" / "hermes" / "api.py").read_text(
            encoding="utf-8"
        )
        assert "doctor(repo_root, probe_version=True)" in api


class TestRefreshPrompts:
    def _with(self, monkeypatch, fake_binary, *, version_out=REAL_0_23, code=0):
        calls: list[tuple[list[str], dict]] = []
        monkeypatch.setattr(soul.shutil, "which", lambda name: str(fake_binary))
        # One `subprocess` module serves both files: the probe is stubbed at
        # its own name so the run below only sees the refresh.
        monkeypatch.setattr(
            soul, "installed_version", lambda binary: parse_version(version_out)
        )

        def run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            return _completed('{"epoch": 3}', code)

        monkeypatch.setattr(soul.subprocess, "run", run)
        return calls

    def test_running_sessions_are_asked_on_the_same_home(
        self, monkeypatch, fake_binary, tmp_path
    ):
        calls = self._with(monkeypatch, fake_binary)
        assert soul.refresh_prompts(home=tmp_path / "h") == "requested"
        ((cmd, kwargs),) = calls
        assert cmd[1:] == ["sessions", "refresh-prompts", "--json"]
        assert kwargs["env"]["HERMES_HOME"] == str(tmp_path / "h")
        assert kwargs["timeout"] <= 30

    def test_an_older_hermes_is_not_asked(self, monkeypatch, fake_binary):
        calls = self._with(
            monkeypatch, fake_binary, version_out="Hermes Agent v0.22.7\n"
        )
        assert soul.refresh_prompts() == "needs-update"
        assert calls == []

    def test_a_failure_is_reported_not_raised(self, monkeypatch, fake_binary):
        self._with(monkeypatch, fake_binary, code=2)
        assert soul.refresh_prompts() == "unavailable"

    def test_no_hermes_no_call(self, monkeypatch):
        monkeypatch.setattr(soul.shutil, "which", lambda name: None)
        monkeypatch.setattr(soul.subprocess, "run", pytest.fail)
        assert soul.refresh_prompts() == "unavailable"


class TestThePackFollowsReleases:
    def test_the_bootstrap_asks_for_the_latest_release(self):
        pack = json.loads(
            (REPO_ROOT / "skills" / "hermes" / "pack.json").read_text(encoding="utf-8")
        )
        assert upstream.bootstrap_ref(pack["bootstrap"]) == upstream.LATEST_RELEASE

    def test_the_receipt_names_a_stable_tag(self):
        receipt = json.loads(
            (REPO_ROOT / "skills" / "hermes" / ".vendored.json").read_text(
                encoding="utf-8"
            )
        )
        assert receipt["follows"] == upstream.LATEST_RELEASE
        assert re.fullmatch(r"v\d+\.\d+\.\d+", receipt["ref"])
        assert satisfies(receipt["ref"][1:]) is True

    def test_the_latest_release_skips_canaries_and_calendar_tags(self, monkeypatch):
        listing = "\n".join(
            f"{'0' * 40}\trefs/tags/{tag}"
            for tag in (
                "v2026.9.24",
                "v0.9.0",
                "v0.22.7",
                "v0.23.0",
                "v0.23.0+canary.20261107T064357Z",
                "v0.24.0-rc.1",
                "v0.100.0-beta",
            )
        )
        monkeypatch.setattr(
            upstream.subprocess, "run", lambda cmd, **kw: _completed(listing)
        )
        assert upstream.latest_release_tag("NousResearch/hermes-agent") == "v0.23.0"
        assert upstream.resolve_ref("x/y", upstream.LATEST_RELEASE) == "v0.23.0"
        assert upstream.resolve_ref("x/y", "v1.0.0") == "v1.0.0"

    def test_no_reachable_tag_is_none_not_head(self, monkeypatch):
        def run(cmd, **kwargs):
            raise subprocess.CalledProcessError(128, cmd)

        monkeypatch.setattr(upstream.subprocess, "run", run)
        assert upstream.resolve_ref("x/y", upstream.LATEST_RELEASE) is None

    @pytest.mark.parametrize(
        ("command", "ref"),
        [
            (["vendor_pack.py", "a/b", "--ref", "v1.2.3"], "v1.2.3"),
            (["vendor_pack.py", "a/b", "--ref=latest-release"], "latest-release"),
            (["vendor_pack.py", "a/b"], "HEAD"),
            ("not a list", "HEAD"),
        ],
    )
    def test_bootstrap_ref(self, command, ref):
        assert upstream.bootstrap_ref({"command": command}) == ref
