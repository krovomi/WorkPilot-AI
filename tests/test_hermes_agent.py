"""hermes-agent as a capability: readiness, persona, and the learning cycle.

The existing `test_hermes_integration.py` covers the *skills* half — the
harness entry that emits nothing, the scoped pack, the ingest that files
candidates. This file covers the half that decides whether any of it runs: the
doctor, `SOUL.md`, and the cycle every feature surface opens.

Everything here is filesystem-only by construction, which is the property worth
protecting: a readiness check that reaches the network is one the Kanban cannot
call on every panel open.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from hermes import doctor, install_soul, run_cycle, soul_status  # noqa: E402
from hermes.home import hermes_home, is_trusted, trusted_project_dirs  # noqa: E402
from hermes.loop import SURFACES, normalise_surface  # noqa: E402


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """A hermes home that exists but was never configured."""
    root = tmp_path / "hermes-home"
    (root / "skills").mkdir(parents=True)
    return root


def _write_config(home: Path, body: str) -> None:
    (home / "config.yaml").write_text(body, encoding="utf-8")


def _write_skill(home: Path, name: str, body: str = "Do the thing.") -> Path:
    path = home / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: A learned procedure.\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return path


class TestHome:
    def test_the_env_override_wins(self, monkeypatch, tmp_path):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / "elsewhere"))
        assert hermes_home() == tmp_path / "elsewhere"

    def test_the_default_is_the_documented_one(self, monkeypatch):
        monkeypatch.delenv("HERMES_HOME", raising=False)
        if sys.platform != "win32":
            assert hermes_home() == Path.home() / ".hermes"

    def test_one_resolution_not_two(self):
        """`hermes_ingest` re-exports it rather than keeping its own copy."""
        from learning_loop import hermes_ingest

        assert hermes_ingest.hermes_home is hermes_home

    def test_a_missing_config_is_not_an_error(self, home):
        assert trusted_project_dirs(home) == []

    def test_a_malformed_config_is_not_an_error(self, home):
        _write_config(home, "skills: [this is not: valid yaml\n")
        assert trusted_project_dirs(home) == []

    def test_a_trusted_checkout_is_recognised(self, home, tmp_path):
        project = tmp_path / "project"
        project.mkdir()
        _write_config(home, f"skills:\n  trusted_project_dirs: ['{project}']\n")
        assert is_trusted(project, home)

    def test_an_untrusted_checkout_is_not(self, home, tmp_path):
        project = tmp_path / "project"
        project.mkdir()
        _write_config(home, "skills:\n  trusted_project_dirs: []\n")
        assert not is_trusted(project, home)


class TestDoctor:
    def test_an_absent_hermes_reports_one_condition_not_five(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr("hermes.readiness._executable", lambda: None)
        report = doctor(REPO_ROOT, home=tmp_path / "nowhere")
        assert not report.installed
        assert report.state == "absent"
        # Four further failures for a tool nobody installed is noise.
        assert [c.name for c in report.checks] == ["install"]

    def test_an_absent_hermes_is_reported_not_raised(self, tmp_path, monkeypatch):
        monkeypatch.setattr("hermes.readiness._executable", lambda: None)
        assert "not installed" in doctor(REPO_ROOT, home=tmp_path / "no").describe()

    def test_a_home_on_disk_counts_as_installed(self, home):
        assert doctor(REPO_ROOT, home=home).installed

    def test_an_untrusted_checkout_is_a_warning_never_a_blocker(self, home):
        report = doctor(REPO_ROOT, home=home)
        assert report.ready, "an untrusted checkout must not stop the ingest"
        assert report.state == "degraded"
        assert "trust" in {c.name for c in report.warnings}

    def test_the_trust_remedy_is_a_command_for_a_person(self, home):
        report = doctor(REPO_ROOT, home=home)
        trust = next(c for c in report.checks if c.name == "trust")
        assert "hermes skills trust" in trust.remedy

    def test_install_is_the_only_required_condition(self, home):
        report = doctor(REPO_ROOT, home=home)
        assert [c.name for c in report.checks if c.required] == ["install"]

    def test_this_repository_satisfies_the_conditions_it_owns(self, home):
        """`.agents/skills` and `AGENTS.md` are committed, so they hold here."""
        report = doctor(REPO_ROOT, home=home)
        by_name = {c.name: c for c in report.checks}
        assert by_name["agents"].ok
        assert by_name["skills"].ok


class TestSoul:
    def test_this_repository_offers_a_persona(self):
        assert soul_status(REPO_ROOT).offered
        assert (REPO_ROOT / "SOUL.md").is_file()

    def test_an_empty_home_reports_not_installed(self, home):
        assert soul_status(REPO_ROOT, home).state == "not-installed"

    def test_installing_writes_the_offered_persona(self, home):
        changed, _ = install_soul(REPO_ROOT, home)
        assert changed
        status = soul_status(REPO_ROOT, home)
        assert status.state == "installed"
        assert status.matches

    def test_installing_twice_changes_nothing(self, home):
        install_soul(REPO_ROOT, home)
        changed, message = install_soul(REPO_ROOT, home)
        assert not changed
        assert "identical" in message

    def test_a_different_persona_is_never_clobbered_silently(self, home):
        (home / "SOUL.md").write_text("You are somebody else.\n", encoding="utf-8")
        changed, message = install_soul(REPO_ROOT, home)
        assert not changed
        assert "overwrite" in message
        assert "somebody else" in (home / "SOUL.md").read_text(encoding="utf-8")

    def test_an_overwrite_keeps_the_old_persona(self, home):
        (home / "SOUL.md").write_text("You are somebody else.\n", encoding="utf-8")
        changed, _ = install_soul(REPO_ROOT, home, overwrite=True)
        assert changed
        backups = list(home.glob("SOUL.*.bak.md"))
        assert len(backups) == 1
        assert "somebody else" in backups[0].read_text(encoding="utf-8")

    def test_the_repo_soul_is_not_a_project_context_file(self):
        """Hermes reads SOUL.md from its home; the project chain is AGENTS.md.

        A test rather than a comment because the whole install path exists for
        this reason: a SOUL.md committed here is an offer, not a config file,
        and somebody will eventually assume the opposite.
        """
        assert soul_status(REPO_ROOT).installed_path != REPO_ROOT / "SOUL.md"


class TestCycle:
    def test_an_unknown_surface_falls_back_rather_than_failing(self):
        assert normalise_surface("whatever") == "build"
        assert normalise_surface(None) == "build"
        assert normalise_surface("KANBAN") == "kanban"

    def test_the_kanban_is_a_surface(self):
        assert "kanban" in SURFACES

    def test_an_absent_hermes_runs_nothing_and_says_so(self, tmp_path, monkeypatch):
        monkeypatch.setattr("hermes.readiness._executable", lambda: None)
        result = run_cycle(tmp_path, surface="kanban", home=tmp_path / "nowhere")
        assert not result.ran
        assert result.readiness.state == "absent"
        assert result.to_dict()["ingest"] is None

    def test_a_cycle_files_candidates_in_the_review_queue(self, home, tmp_path):
        _write_skill(home, "diagnose-the-flake")
        repo = tmp_path / "repo"
        repo.mkdir()
        result = run_cycle(repo, surface="kanban", home=home)
        assert result.ran
        assert result.proposed == 1
        proposed = repo / "skills" / "_proposed"
        assert [p.name for p in proposed.glob("*.md")] == [
            "hermes--diagnose-the-flake.md"
        ]

    def test_the_surface_is_recorded_on_the_candidate(self, home, tmp_path):
        _write_skill(home, "diagnose-the-flake")
        repo = tmp_path / "repo"
        repo.mkdir()
        run_cycle(repo, surface="kanban", home=home)
        body = (
            repo / "skills" / "_proposed" / "hermes--diagnose-the-flake.md"
        ).read_text(encoding="utf-8")
        assert "surface: kanban" in body

    def test_a_dry_run_writes_nothing(self, home, tmp_path):
        _write_skill(home, "diagnose-the-flake")
        repo = tmp_path / "repo"
        repo.mkdir()
        result = run_cycle(repo, surface="cli", home=home, write=False)
        assert result.proposed == 1
        assert not (repo / "skills" / "_proposed").exists()

    def test_a_candidate_carries_no_external_signal(self, home, tmp_path):
        """The whole reason hermes proposes and never promotes."""
        _write_skill(home, "diagnose-the-flake")
        repo = tmp_path / "repo"
        repo.mkdir()
        run_cycle(repo, surface="kanban", home=home)
        body = (
            repo / "skills" / "_proposed" / "hermes--diagnose-the-flake.md"
        ).read_text(encoding="utf-8")
        assert "NO external verification signal" in body
        assert "tests_passed" not in body

    def test_re_running_the_cycle_does_not_re_propose(self, home, tmp_path):
        _write_skill(home, "diagnose-the-flake")
        repo = tmp_path / "repo"
        repo.mkdir()
        run_cycle(repo, surface="kanban", home=home)
        second = run_cycle(repo, surface="kanban", home=home)
        assert second.proposed == 0
        assert second.ingest.unchanged == 1

    def test_a_cycle_never_writes_into_the_hermes_home(self, home, tmp_path):
        _write_skill(home, "diagnose-the-flake")
        before = sorted(p.name for p in home.rglob("*"))
        repo = tmp_path / "repo"
        repo.mkdir()
        run_cycle(repo, surface="kanban", home=home)
        assert sorted(p.name for p in home.rglob("*")) == before


class TestWiredIn:
    def test_the_observe_phase_documents_the_cycle(self):
        text = (REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml").read_text(
            encoding="utf-8"
        )
        assert "hermes.loop" in text, (
            "the build surface of the loop must be visible in the resolved profile"
        )

    def test_the_router_is_mounted(self):
        text = (REPO_ROOT / "apps" / "backend" / "provider_api.py").read_text(
            encoding="utf-8"
        )
        assert "from hermes.api import router" in text

    def test_the_router_has_a_permission(self):
        # `_mount` gates a router by the domain its feature maps onto; a
        # feature with no entry mounts unguarded in server mode.
        pytest.importorskip("fastapi")
        from server.authz.catalog import domain_for_feature

        assert domain_for_feature("hermes") == "agent"

    def test_nothing_grants_trust_on_the_user_s_behalf(self):
        """Trusting a checkout is a person's decision, not a button's.

        Approving a repository makes every SKILL.md in it a procedure hermes
        will follow in every session on the machine. Software that writes that
        list has removed the gate it was given, so the package reads the trust
        config and reports it, and the only file it ever writes is the persona.
        """
        package = REPO_ROOT / "apps" / "backend" / "hermes"
        writers = sorted(
            path.name
            for path in package.glob("*.py")
            if "write_text(" in path.read_text(encoding="utf-8")
        )
        assert writers == ["soul.py"]

    def test_both_locales_declare_the_same_keys(self):
        import json

        base = REPO_ROOT / "apps/frontend/src/shared/i18n/locales"
        en = json.loads((base / "en" / "hermes.json").read_text(encoding="utf-8"))
        fr = json.loads((base / "fr" / "hermes.json").read_text(encoding="utf-8"))

        def keys(obj, prefix=""):
            out = set()
            for key, value in obj.items():
                path = f"{prefix}{key}"
                out.add(path)
                if isinstance(value, dict):
                    out |= keys(value, f"{path}.")
            return out

        assert keys(en) == keys(fr)
