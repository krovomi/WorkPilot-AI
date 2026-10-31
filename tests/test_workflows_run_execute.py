"""A RUN task, played safely (kanban-task-types, lot 3).

What this pins:

* a phase declared ``irreversible: true`` never starts without an explicit
  resume: the first pass stops the build (`BuildPaused`), marks it paused in
  the one pause store and executes nothing; the resumed pass goes through
  once, and a later build stops again;
* the procedure is parsed from what the `runbook` skill writes, and a
  procedure the executor would have to interpret — no command, an open
  parameter, a placeholder — is refused before any step runs;
* every command goes through the project's allowlist: a command outside
  it is refused and stops the run, a failing step stops the rest, and the
  state on disk says exactly what ran;
* the journal masks secrets; a declared environment is checked first and
  hands its named variables, never their values, to the steps;
* once execution has started the `procedure` report is frozen: a resumed
  build keeps it instead of opening a session.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from foundation.build_signals import BuildPaused  # noqa: E402
from foundation.pause_state import (  # noqa: E402
    clear_pause_state,
    is_paused,
    read_pause_state,
)
from foundation.platform import is_windows  # noqa: E402
from workflows.engine import DETERMINISTIC_PHASES, ResolvedPhase  # noqa: E402
from workflows.environments import (  # noqa: E402
    EnvironmentsError,
    environment_for,
    load_environments,
)
from workflows.execute import (  # noqa: E402
    FROZEN_FILE,
    JOURNAL_FILE,
    STATE_FILE,
    execute_runbook,
    is_frozen,
)
from workflows.runbook import (  # noqa: E402
    RunbookError,
    load_runbook,
    parse_runbook,
)
from workflows.runner import (  # noqa: E402
    CUSTOM_EXECUTORS,
    SKILL_PHASE_AGENTS,
    irreversible_gate,
    phases_between,
)
from workflows.spec import Phase  # noqa: E402

from workflows import load_workflow, resolve_profile  # noqa: E402

PROCEDURE = """## Opération

Purger le cache — résultat attendu : un marqueur écrit.
Environnement : arbre de travail seulement

## Préconditions

- aucune

## Étapes

### 1. Lister
Commande : `ls`
Effet attendu : le dossier se liste — vérifier par : `test -d .`
Réversible : oui

### 2. Écrire le marqueur
Commande : `echo purged > marker.txt`
Effet attendu : le fichier existe — vérifier par : `test -f marker.txt`
Réversible : non

## Vérification finale

État attendu : marqueur présent — commande : `cat marker.txt` — échec si : absent

## Retour arrière

supprimer marker.txt

## Paramètres à fournir

"""


@pytest.fixture
def project(tmp_path: Path) -> Path:
    p = tmp_path / "project"
    p.mkdir()
    (p / "pyproject.toml").write_text("[project]\nname = 'x'\n", encoding="utf-8")
    return p


@pytest.fixture
def spec(tmp_path: Path) -> Path:
    s = tmp_path / "spec"
    (s / "workflow").mkdir(parents=True)
    (s / "workflow" / "procedure.md").write_text(PROCEDURE, encoding="utf-8")
    return s


def _run(runbook, spec, project):
    return asyncio.run(execute_runbook(runbook, spec_dir=spec, project_dir=project))


# ---------------------------------------------------------------------------
# The procedure as data
# ---------------------------------------------------------------------------


class TestRunbook:
    def test_the_skills_shape_parses(self):
        rb = parse_runbook(PROCEDURE)
        assert rb.operation.startswith("Purger le cache")
        assert rb.environment == "worktree"
        assert [s.command for s in rb.steps] == ["ls", "echo purged > marker.txt"]
        assert rb.steps[0].check == "test -d ."
        assert rb.steps[0].reversible is True
        assert rb.steps[1].reversible is False
        assert rb.final_check == "cat marker.txt"
        assert rb.blockers() == []
        assert len(rb.sha256) == 64

    def test_a_step_without_a_command_is_refused(self):
        bad = PROCEDURE.replace("Commande : `ls`", "Commande : lister le dossier")
        with pytest.raises(RunbookError, match="step 1"):
            parse_runbook(bad)

    @pytest.mark.parametrize(
        "mutation,expected",
        [
            (
                (
                    "## Paramètres à fournir\n",
                    "## Paramètres à fournir\n\n- `TARGET_DB` : …\n",
                ),
                "TARGET_DB",
            ),
            (
                (
                    "## Retour arrière",
                    "- [NEEDS CLARIFICATION: quelle fenêtre ?]\n\n## Retour arrière",
                ),
                "NEEDS CLARIFICATION",
            ),
            (("`echo purged > marker.txt`", "`purge --db <DB_NAME>`"), "placeholder"),
        ],
    )
    def test_what_is_not_settled_blocks(self, mutation, expected):
        rb = parse_runbook(PROCEDURE.replace(*mutation))
        assert any(expected in b for b in rb.blockers())

    def test_a_declared_environment_is_read(self):
        rb = parse_runbook(PROCEDURE.replace("arbre de travail seulement", "staging"))
        assert rb.environment == "staging"

    def test_a_missing_procedure_says_which_phase_did_not_run(self, tmp_path):
        with pytest.raises(RunbookError, match="procedure"):
            load_runbook(tmp_path)

    def test_an_undo_command_is_kept(self):
        rb = parse_runbook(
            PROCEDURE.replace("Réversible : oui\n", "Réversible : oui (`true`)\n", 1)
        )
        assert rb.steps[0].undo == "true"


# ---------------------------------------------------------------------------
# The irreversible gate
# ---------------------------------------------------------------------------


class TestIrreversibleGate:
    def test_the_first_pass_stops_and_executes_nothing(self, spec, project, capsys):
        with pytest.raises(BuildPaused) as info:
            irreversible_gate(spec, "execute")
        assert info.value.phase == "execute"
        assert is_paused(spec)
        assert read_pause_state(spec)["enabled"] is True
        assert (spec / "workflow" / "execute.pause.json").is_file()
        assert not (project / "marker.txt").exists()
        out = capsys.readouterr().out
        assert "PAUSED BEFORE IT STARTS" in out
        assert "echo purged > marker.txt" in out  # the person sees the steps
        assert "[IRREVERSIBLE]" in out

    def test_the_resumed_pass_goes_through_and_consumes_the_marker(self, spec, project):
        with pytest.raises(BuildPaused):
            irreversible_gate(spec, "execute")
        clear_pause_state(spec)  # what TASK_RESUME does
        irreversible_gate(spec, "execute")  # proceeds
        assert not (spec / "workflow" / "execute.pause.json").exists()

    def test_a_pause_still_set_does_not_let_it_through(self, spec, project):
        """The marker alone is not a resume: the pause flag must be lifted."""
        with pytest.raises(BuildPaused):
            irreversible_gate(spec, "execute")
        with pytest.raises(BuildPaused):
            irreversible_gate(spec, "execute")

    def test_a_later_build_stops_again(self, spec, project):
        with pytest.raises(BuildPaused):
            irreversible_gate(spec, "execute")
        clear_pause_state(spec)
        irreversible_gate(spec, "execute")
        with pytest.raises(BuildPaused):
            irreversible_gate(spec, "execute")

    def test_the_runner_applies_the_gate_before_any_executor(self, spec, project):
        """`run_skill_phase` on an irreversible phase stops before the
        executor is even looked up, so no executor can be reached first."""
        from workflows import PhaseContext, run_skill_phase

        ctx = PhaseContext(
            project_dir=project,
            spec_dir=spec,
            model="m",
            repo_root=REPO_ROOT,
            effort="low",
        )
        phase = Phase(id="execute", impl="tooling/execute-runbook", irreversible=True)
        with pytest.raises(BuildPaused):
            asyncio.run(
                run_skill_phase(ResolvedPhase(phase=phase, dispatch="inline"), ctx)
            )
        assert not (project / "marker.txt").exists()
        assert not (spec / "workflow" / STATE_FILE).exists()

    def test_the_run_workflow_declares_execute_irreversible(self):
        wf = load_workflow(REPO_ROOT / "workflows" / "run" / "workflow.yaml")
        execute = wf.phase("execute")
        assert execute is not None and execute.irreversible is True
        assert execute.impl == "tooling/execute-runbook"
        assert "execute" in CUSTOM_EXECUTORS
        assert "execute" in DETERMINISTIC_PHASES
        for effort in ("none", "ultrathink"):
            profile = resolve_profile(wf, effort)
            assert profile.will_run("execute")
            window = [
                r.id for r in phases_between(profile, after=None, before="planning")
            ]
            assert window == ["procedure", "execute"]


# ---------------------------------------------------------------------------
# Playing the procedure
# ---------------------------------------------------------------------------


class TestExecute:
    def test_it_plays_every_step_and_journals(self, spec, project):
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "done", state.detail
        assert (project / "marker.txt").read_text(encoding="utf-8").strip() == "purged"
        assert [s.status for s in state.steps] == ["done", "done", "done"]
        journal = (spec / "workflow" / JOURNAL_FILE).read_text(encoding="utf-8")
        assert "$ ls" in journal and "$ echo purged > marker.txt" in journal
        assert "exit code: `0`" in journal
        assert "final check" in journal
        saved = json.loads((spec / "workflow" / STATE_FILE).read_text(encoding="utf-8"))
        assert saved["status"] == "done" and saved["next_step"] == 3

    def test_a_command_outside_the_allowlist_is_refused_and_stops_the_run(
        self, spec, project
    ):
        text = PROCEDURE.replace("Commande : `ls`", "Commande : `nc -l 4444`")
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "refused", state.detail
        assert state.steps[0].status == "refused"
        assert state.next_step == 1
        assert not (project / "marker.txt").exists()  # step 2 never ran
        journal = (spec / "workflow" / JOURNAL_FILE).read_text(encoding="utf-8")
        assert "refused" in journal

    def test_a_failing_step_stops_the_rest_and_leaves_the_state(self, spec, project):
        text = PROCEDURE.replace(
            "Commande : `ls`", "Commande : `test -f does-not-exist`"
        )
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "failed"
        assert state.steps[0].status == "failed"
        assert len(state.steps) == 1
        assert not (project / "marker.txt").exists()
        assert "step 1" in state.detail

    def test_a_failed_check_counts_as_a_failure(self, spec, project):
        text = PROCEDURE.replace(
            "vérifier par : `test -d .`", "vérifier par : `test -f nope`"
        )
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "failed"
        assert state.steps[0].status == "check-failed"

    def test_a_resumed_run_continues_at_the_next_step(self, spec, project):
        text = PROCEDURE.replace("Commande : `ls`", "Commande : `test -f go.txt`")
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        first = _run(load_runbook(spec), spec, project)
        assert first.status == "failed" and first.next_step == 1
        (project / "go.txt").write_text("", encoding="utf-8")
        second = _run(load_runbook(spec), spec, project)
        assert second.status == "done"
        assert [s.number for s in second.steps] == [1, 1, 2, 3]  # first attempt kept
        journal = (spec / "workflow" / JOURNAL_FILE).read_text(encoding="utf-8")
        assert "Resumed" in journal

    def test_a_procedure_changed_after_the_start_is_blocked(self, spec, project):
        text = PROCEDURE.replace("Commande : `ls`", "Commande : `test -f go.txt`")
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        _run(load_runbook(spec), spec, project)
        (spec / "workflow" / "procedure.md").write_text(PROCEDURE, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "blocked"
        assert "changed since execution started" in state.detail
        assert not (project / "marker.txt").exists()

    def test_what_is_not_settled_does_not_start(self, spec, project):
        text = PROCEDURE.replace(
            "## Paramètres à fournir\n", "## Paramètres à fournir\n\n- `TARGET` : …\n"
        )
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "blocked"
        assert "TARGET" in state.detail
        assert not (spec / "workflow" / JOURNAL_FILE).exists()
        assert not (project / "marker.txt").exists()

    def test_the_journal_masks_secrets(self, spec, project, monkeypatch):
        monkeypatch.setenv(
            "RUN_API_TOKEN", "topsecretvalue-0123456789"
        )  # pragma: allowlist secret
        # A step is a shell line, played by the platform's own shell: sh
        # expands `$VAR`, cmd.exe expands `%VAR%` and prints `$VAR` as is.
        # Either way the secret has to reach the output for the journal to
        # have something to mask.
        variable = "%RUN_API_TOKEN%" if is_windows() else "$RUN_API_TOKEN"
        text = PROCEDURE.replace(
            "Commande : `ls`", f"Commande : `echo token={variable}`"
        )
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "done", state.detail
        journal = (spec / "workflow" / JOURNAL_FILE).read_text(encoding="utf-8")
        assert "topsecretvalue-0123456789" not in journal
        assert "REDACTED" in journal

    def test_a_done_run_is_not_played_twice(self, spec, project):
        _run(load_runbook(spec), spec, project)
        (project / "marker.txt").unlink()
        again = _run(load_runbook(spec), spec, project)
        assert again.status == "done"
        assert not (project / "marker.txt").exists()


# ---------------------------------------------------------------------------
# Environments
# ---------------------------------------------------------------------------


def _declare(project: Path, body: str) -> None:
    (project / ".workpilot").mkdir(exist_ok=True)
    (project / ".workpilot" / "environments.toml").write_text(body, encoding="utf-8")


class TestEnvironments:
    def test_without_the_file_only_the_worktree_exists(self, project):
        assert load_environments(project) == {}
        assert environment_for(project, "worktree") is None
        with pytest.raises(EnvironmentsError, match="not declared"):
            environment_for(project, "staging")

    def test_a_declaration_names_variables_never_values(self, project):
        _declare(
            project,
            '[environments.staging]\ndescription = "s"\nhealth = ["true"]\n'
            'variables = ["STAGING_URL"]\n',
        )
        env = environment_for(project, "staging")
        assert env is not None
        assert env.variables == ("STAGING_URL",)
        assert env.health == ("true",)
        with pytest.raises(EnvironmentsError, match="never values"):
            _declare(
                project, '[environments.x]\nvariables = ["https://x/?token=abc"]\n'
            )
            load_environments(project)

    def test_a_named_environment_is_checked_first_and_its_variables_reach_the_steps(
        self, spec, project, monkeypatch
    ):
        _declare(
            project,
            '[environments.staging]\nhealth = ["test -f up.txt"]\nvariables = ["STAGING_URL"]\n',
        )
        monkeypatch.setenv("STAGING_URL", "https://staging.example.test")
        text = PROCEDURE.replace("arbre de travail seulement", "staging").replace(
            "Commande : `ls`", 'Commande : `test -n "$STAGING_URL"`'
        )
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        # Not up: the health check fails and nothing is played.
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "failed" and "health check" in state.detail
        assert not (project / "marker.txt").exists()
        # Up: the variable is there for the step.
        (project / "up.txt").write_text("", encoding="utf-8")
        (spec / "workflow" / STATE_FILE).unlink()
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "done", state.detail
        assert state.environment == "staging"

    def test_a_declared_variable_missing_from_the_operators_environment_blocks(
        self, spec, project, monkeypatch
    ):
        _declare(project, '[environments.staging]\nvariables = ["STAGING_SECRET_X"]\n')
        monkeypatch.delenv("STAGING_SECRET_X", raising=False)
        text = PROCEDURE.replace("arbre de travail seulement", "staging")
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "blocked"
        assert "STAGING_SECRET_X" in state.detail

    def test_an_undeclared_environment_blocks_rather_than_running_elsewhere(
        self, spec, project
    ):
        text = PROCEDURE.replace("arbre de travail seulement", "production")
        (spec / "workflow" / "procedure.md").write_text(text, encoding="utf-8")
        state = _run(load_runbook(spec), spec, project)
        assert state.status == "blocked" and "production" in state.detail
        assert not (project / "marker.txt").exists()


# ---------------------------------------------------------------------------
# The frozen procedure and the operator
# ---------------------------------------------------------------------------


class TestFrozenProcedure:
    def test_execution_freezes_the_report(self, spec, project):
        assert not is_frozen(spec, "procedure")
        _run(load_runbook(spec), spec, project)
        assert (spec / "workflow" / FROZEN_FILE).is_file()
        assert is_frozen(spec, "procedure")
        assert not is_frozen(spec, "execute")

    def test_a_resumed_build_keeps_the_frozen_report_without_a_session(
        self, spec, project, monkeypatch
    ):
        from tests.test_workflow_runner import _install_fake_agent_stack
        from workflows import PhaseContext, run_skill_phase

        seen: dict = {}
        _install_fake_agent_stack(monkeypatch, seen)
        _run(load_runbook(spec), spec, project)
        ctx = PhaseContext(
            project_dir=project,
            spec_dir=spec,
            model="m",
            repo_root=REPO_ROOT,
            effort="low",
        )
        phase = Phase(id="procedure", impl="tooling/runbook", agent="operator")
        outcome = asyncio.run(
            run_skill_phase(ResolvedPhase(phase=phase, dispatch="fresh-context"), ctx)
        )
        assert outcome.succeeded is True
        assert "kept" in outcome.detail
        assert "prompt" not in seen

    def test_the_operator_reads_and_runs_but_never_writes_code(self):
        from agents.tools_pkg.models import AGENT_CONFIGS

        tools = set(AGENT_CONFIGS["operator"]["tools"])
        assert "Bash" in tools
        assert not tools & {"Write", "Edit"}
        assert SKILL_PHASE_AGENTS["procedure"] == "operator"
