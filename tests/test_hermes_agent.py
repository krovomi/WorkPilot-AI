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
from learning_loop.hermes_ingest import discover_authored_skills  # noqa: E402


@pytest.fixture
def home(tmp_path: Path) -> Path:
    """A hermes home that exists but was never configured."""
    root = tmp_path / "hermes-home"
    (root / "skills").mkdir(parents=True)
    return root


def _write_config(home: Path, body: str) -> None:
    (home / "config.yaml").write_text(body, encoding="utf-8")


def _write_skill(
    home: Path, name: str, body: str = "Do the thing.", *, authored: bool = True
) -> Path:
    """A skill in the hermes home, recorded as the agent's own unless told not to."""
    path = home / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: A learned procedure.\n---\n\n{body}\n",
        encoding="utf-8",
    )
    if authored:
        _record_authorship(home, name)
    return path


def _record_authorship(home: Path, *names: str) -> None:
    """What `skill_manage` writes into `.usage.json` when the agent authors one."""
    import json

    usage = home / "skills" / ".usage.json"
    data = {}
    if usage.is_file():
        data = json.loads(usage.read_text(encoding="utf-8"))
    for name in names:
        data[name] = {"created_by": "agent", "use_count": 1}
    usage.write_text(json.dumps(data), encoding="utf-8")


def _write_bundled_manifest(home: Path, *names: str) -> None:
    """The real format: ``name:hash`` per line, never JSON."""
    (home / "skills" / ".bundled_manifest").write_text(
        "".join(f"{n}:abc123\n" for n in names), encoding="utf-8"
    )


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


class TestOnlyWhatHermesLearned:
    """The regression that produced sixty files, and the rule that replaces it.

    A build on a real hermes install proposed the whole upstream catalogue —
    `airtable`, `apple-notes`, `imessage`, `songwriting-and-ai-music` — because
    `.bundled_manifest` was read as JSON, every line raised, and the exclusion
    matched nothing. The parse is fixed, but the fix that matters is the change
    of rule: hermes records what it authored, so that is what gets asked.
    """

    def test_the_manifest_is_name_colon_hash_not_json(self, home):
        from learning_loop.hermes_ingest import _manifest_names

        _write_bundled_manifest(home, "airtable", "apple-notes", "imessage")
        assert _manifest_names(home / "skills") == {
            "airtable",
            "apple-notes",
            "imessage",
        }

    def test_a_shipped_catalogue_proposes_nothing(self, home, tmp_path):
        """The exact shape of the flood: many skills, none of them authored."""
        shipped = ["airtable", "apple-notes", "imessage", "songwriting-and-ai-music"]
        for name in shipped:
            _write_skill(home, name, authored=False)
        _write_bundled_manifest(home, *shipped)

        repo = tmp_path / "repo"
        repo.mkdir()
        result = run_cycle(repo, surface="build", home=home)
        assert result.proposed == 0
        assert not (repo / "skills" / "_proposed").exists()

    def test_an_unrecorded_skill_is_not_a_candidate(self, home):
        """No manifest, no record: still not proposed. The rule is the allowlist."""
        _write_skill(home, "apple-notes", authored=False)
        assert discover_authored_skills(home) == []

    def test_an_authored_skill_still_is(self, home):
        _write_skill(home, "diagnose-the-flake")
        assert [c.name for c in discover_authored_skills(home)] == [
            "diagnose-the-flake"
        ]

    def test_the_older_marker_counts_too(self, home):
        import json

        _write_skill(home, "diagnose-the-flake", authored=False)
        (home / "skills" / ".usage.json").write_text(
            json.dumps({"diagnose-the-flake": {"agent_created": True}}),
            encoding="utf-8",
        )
        assert len(discover_authored_skills(home)) == 1

    def test_shipped_wins_over_a_record_that_says_agent(self, home):
        """`curator adopt` can mark a shipped skill; the manifest is the tiebreak."""
        _write_skill(home, "systematic-debugging")
        _write_bundled_manifest(home, "systematic-debugging")
        assert discover_authored_skills(home) == []

    def test_a_hub_install_is_not_experience(self, home):
        import json

        _write_skill(home, "arxiv")
        hub = home / "skills" / ".hub"
        hub.mkdir(parents=True, exist_ok=True)
        (hub / "lock.json").write_text(
            json.dumps({"installed": {"arxiv": {"version": "1.0.0"}}}), encoding="utf-8"
        )
        assert discover_authored_skills(home) == []

    def test_the_approval_queue_needs_no_record(self, home):
        """A skill awaiting approval is authored by definition — its record
        does not exist yet, and filtering on one would drop the newest."""
        staged = home / "pending" / "skills" / "just-written" / "SKILL.md"
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_text(
            "---\nname: just-written\ndescription: Fresh.\n---\n\nBody.\n",
            encoding="utf-8",
        )
        found = discover_authored_skills(home)
        assert [c.name for c in found] == ["just-written"]
        assert found[0].staged

    def test_a_malformed_usage_file_proposes_nothing(self, home):
        """Fails closed. The old denylist failed open, which is how this started."""
        _write_skill(home, "diagnose-the-flake")
        (home / "skills" / ".usage.json").write_text("{not json", encoding="utf-8")
        assert discover_authored_skills(home) == []


class TestSelfHealingSurface:
    """The loop turns at the end of an incident cycle, not only after a build.

    Same shape as the `observe` phase: a unit of work ended, so ask what hermes
    learned. Different surface, so the candidate says which one asked.
    """

    def _orchestrator(self, project_dir: Path):
        pytest.importorskip("self_healing.incident_responder.orchestrator")
        from self_healing.incident_responder.models import HealingOperation, Incident
        from self_healing.incident_responder.orchestrator import (
            IncidentResponderOrchestrator,
        )

        orch = IncidentResponderOrchestrator(project_dir, auto_create_pr=False)
        return orch, HealingOperation, Incident

    def test_a_finished_incident_files_what_hermes_learned(
        self, home, tmp_path, monkeypatch
    ):
        _write_skill(home, "diagnose-the-flake")
        project = tmp_path / "project"
        project.mkdir()
        orch, HealingOperation, Incident = self._orchestrator(project)

        # The cycle resolves the home itself; point it at the fixture.
        monkeypatch.setenv("HERMES_HOME", str(home))

        operation = HealingOperation(incident=Incident(title="t", description="d"))
        orch._observe_with_hermes(operation)

        proposed = project / "skills" / "_proposed"
        assert [p.name for p in proposed.glob("*.md")] == [
            "hermes--diagnose-the-flake.md"
        ]
        body = (proposed / "hermes--diagnose-the-flake.md").read_text(encoding="utf-8")
        assert "surface: self-healing" in body

    def test_it_reports_only_when_it_filed_something(self, home, tmp_path, monkeypatch):
        """A '0 proposed' row on every incident is a row nobody reads."""
        project = tmp_path / "project"
        project.mkdir()
        orch, HealingOperation, Incident = self._orchestrator(project)
        monkeypatch.setenv("HERMES_HOME", str(home))

        operation = HealingOperation(incident=Incident(title="t", description="d"))
        orch._observe_with_hermes(operation)
        assert operation.steps == []

    def test_an_absent_hermes_adds_no_step_and_does_not_raise(
        self, tmp_path, monkeypatch
    ):
        project = tmp_path / "project"
        project.mkdir()
        orch, HealingOperation, Incident = self._orchestrator(project)
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / "nowhere"))

        operation = HealingOperation(incident=Incident(title="t", description="d"))
        orch._observe_with_hermes(operation)
        assert operation.steps == []

    def test_it_runs_in_finally_so_a_failed_pipeline_still_observes(self):
        """A pipeline that failed is not a reason to skip the question."""
        source = (
            REPO_ROOT / "apps/backend/self_healing/incident_responder/orchestrator.py"
        ).read_text(encoding="utf-8")
        tail = source[source.index("async def _run_healing_pipeline") :]
        body = tail[: tail.index("def _observe_with_hermes")]
        assert "finally:" in body
        assert body.index("finally:") < body.index("self._observe_with_hermes")


class TestProviderIndependence:
    """The loop must work whichever LLM is driving, and stay that way.

    It does today by construction — every answer comes from files on disk — but
    "by construction" is a property nobody is currently forced to preserve. The
    obvious way to break it is to reach for `create_client` the first time the
    cycle wants a model to summarise something, and the breakage would be
    invisible to anyone running Claude.
    """

    HERMES_PACKAGE = REPO_ROOT / "apps" / "backend" / "hermes"

    def test_the_package_names_no_provider(self):
        for path in sorted(self.HERMES_PACKAGE.glob("*.py")):
            body = path.read_text(encoding="utf-8").lower()
            for token in ("anthropic", "claude_agent_sdk", "create_client", "openai"):
                assert token not in body, (
                    f"{path.name} names {token}: the hermes cycle answers from "
                    "files on disk, and a model call here would make the "
                    "learning loop work on one provider and quietly not on the "
                    "others"
                )

    def test_the_ingest_names_no_provider(self):
        body = (
            (REPO_ROOT / "apps/backend/learning_loop/hermes_ingest.py")
            .read_text(encoding="utf-8")
            .lower()
        )
        for token in ("anthropic", "claude_agent_sdk", "create_client"):
            assert token not in body

    def test_a_cycle_runs_with_no_llm_configured(self, home, tmp_path, monkeypatch):
        """No key, no provider selection, no network: it still files candidates."""
        for var in (
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "WORKPILOT_PROVIDER",
            "RESUME_WITH_PROVIDER",
        ):
            monkeypatch.delenv(var, raising=False)
        _write_skill(home, "diagnose-the-flake")
        repo = tmp_path / "repo"
        repo.mkdir()
        assert run_cycle(repo, surface="cli", home=home).proposed == 1


class TestPortability:
    """A candidate arrives in hermes's dialect; adopting it is a rewrite.

    `skills/<pack>/` is emitted to Claude Code, Copilot, Codex, Cursor and
    Gemini. A skill hermes wrote says `read_file` and `terminal`, which none of
    them have — so the candidate has to say so, or the first person to run the
    adopted skill discovers it instead.
    """

    def test_hermes_tool_names_are_reported(self):
        from learning_loop.hermes_ingest import hermes_tools_used

        body = "Read it with `read_file`, then use the `terminal` tool."
        assert hermes_tools_used(body) == ["terminal", "read_file"]

    def test_the_bare_word_is_not_a_tool_reference(self):
        """Hermes's authoring standard requires backticks; English does not."""
        from learning_loop.hermes_ingest import hermes_tools_used

        assert hermes_tools_used("Apply a patch, then read the file.") == []
        assert hermes_tools_used("The memory of the terminal session.") == []

    def test_the_candidate_carries_the_translation(self, home, tmp_path):
        _write_skill(home, "debug-it", "Run it through the `terminal` tool.")
        repo = tmp_path / "repo"
        repo.mkdir()
        run_cycle(repo, surface="build", home=home)
        body = (repo / "skills" / "_proposed" / "hermes--debug-it.md").read_text(
            encoding="utf-8"
        )
        assert "## Portability" in body
        assert "| `terminal` | Bash |" in body

    def test_a_portable_candidate_says_so(self, home, tmp_path):
        _write_skill(home, "think-first", "Question the design before coding.")
        repo = tmp_path / "repo"
        repo.mkdir()
        run_cycle(repo, surface="build", home=home)
        body = (repo / "skills" / "_proposed" / "hermes--think-first.md").read_text(
            encoding="utf-8"
        )
        assert "portable as written" in body

    def test_the_body_is_never_rewritten(self, home, tmp_path):
        """Find-and-replace would leave the prose describing a tool it no
        longer names. The reviewer rewrites; the ingest reports."""
        original = "Invoke the script through the `terminal` tool."
        _write_skill(home, "debug-it", original)
        repo = tmp_path / "repo"
        repo.mkdir()
        run_cycle(repo, surface="build", home=home)
        body = (repo / "skills" / "_proposed" / "hermes--debug-it.md").read_text(
            encoding="utf-8"
        )
        assert original in body

    def test_the_harness_matrix_carries_the_same_vocabulary(self):
        import yaml
        from learning_loop.hermes_ingest import _HERMES_TOOLS

        matrix = yaml.safe_load(
            (REPO_ROOT / "capabilities" / "harnesses.yaml").read_text(encoding="utf-8")
        )
        declared = set(matrix["hermes"]["tools"].values())
        assert declared, "an empty map claims there is nothing to translate"
        assert declared <= set(_HERMES_TOOLS), (
            "harnesses.yaml and hermes_ingest disagree about hermes's tool names"
        )


class TestPhaseRosters:
    """Every skill phase gets specialists that match what it can see.

    Three phases fell through to the Kanban default because their agent_type
    had no entry in `PHASE_ALIASES`, and two of them run before a line of code
    exists — so `brainstorm` and `analyze` were each handed a `test-runner`
    with nothing to run, and `spec-conformance` was denied the
    `qa-acceptance-checker` its own description in the workflow file names.
    The roster is context the parent pays for on every turn, so a wrong roster
    is not merely unhelpful; it is billed.
    """

    def _rows(self):
        from agents.subagents.phases import phase_specs
        from workflows.runner import SKILL_PHASE_AGENTS
        from workflows.spec import load_workflow

        workflow = load_workflow(
            REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"
        )
        for phase in workflow.phases:
            agent_type = phase.agent or SKILL_PHASE_AGENTS.get(phase.id)
            if agent_type is None:
                continue
            yield phase, agent_type, set(phase_specs(agent_type, phase.roster))

    def test_no_phase_falls_through_to_the_kanban_default(self):
        from agents.subagents.phases import PHASE_ALIASES

        for phase, agent_type, _ in self._rows():
            assert phase.roster or agent_type in PHASE_ALIASES, (
                f"{phase.id} runs under {agent_type}, which no alias maps: it "
                "silently gets the Kanban roster"
            )

    def test_a_phase_that_precedes_the_code_gets_no_test_runner(self):
        before_code = {"brainstorm", "spec", "analyze"}
        for phase, _, names in self._rows():
            if phase.id in before_code:
                assert "test-runner" not in names, (
                    f"{phase.id} runs before any code is written"
                )

    def test_spec_conformance_gets_the_subagent_it_names(self):
        for phase, _, names in self._rows():
            if phase.id == "spec-conformance":
                assert "qa-acceptance-checker" in names
                break
        else:  # pragma: no cover - the phase is declared
            pytest.fail("spec-conformance is not declared")

    def test_the_roster_never_widens_permissions(self):
        """`roster:` exists so a read-only phase keeps its specialists AND its
        read-only config. Reaching them via `agent:` would have traded one for
        the other."""
        readonly = {
            "analyzer",
            "spec_critic",
            "spec_validation",
            "spec_context",
            "spec_discovery",
            "pr_reviewer",
            "pr_orchestrator_parallel",
            "insights",
        }
        client = (REPO_ROOT / "apps/backend/core/client.py").read_text(encoding="utf-8")
        assert '"spec_validation",' in client, "the read-only set moved"
        for phase, agent_type, _ in self._rows():
            if phase.roster:
                assert agent_type in readonly or phase.id == "verify", (
                    f"{phase.id} sets a roster; check it still needs no write access"
                )

    def test_an_unknown_roster_falls_back_rather_than_raising(self):
        """A typo in a workflow file costs the right roster, not the build."""
        from agents.subagents.phases import phase_specs

        assert phase_specs("spec_validation", "nonsense") == phase_specs(
            "spec_validation"
        )

    def test_the_field_survives_a_round_trip(self):
        from workflows.spec import load_workflow

        workflow = load_workflow(
            REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml"
        )
        declared = {p.id: p.roster for p in workflow.phases if p.roster}
        assert declared == {"analyze": "planner", "spec-conformance": "qa"}


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
