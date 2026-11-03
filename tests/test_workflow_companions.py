"""A workflow phase may offer companion procedures, each for the case it names.

The phase keeps following its own `impl`; a companion is a file the model opens
when its case applies. This is how the hermes debugging procedures reach the
bug-fix, hotfix and investigation workflows without replacing WorkPilot's own
`reproduce` and `investigate` — and why a weekly sync that drops one of them
must turn this suite red rather than leave a phase pointing at nothing.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.runner import (  # noqa: E402
    _ELSEWHERE,
    BUILTIN_EXECUTORS,
    DETERMINISTIC_EXECUTORS,
    PhaseContext,
    _build_prompt,
    companion_lines,
)
from workflows.spec import WorkflowError, _parse_phase, load_workflow  # noqa: E402

WORKFLOWS = sorted(
    p.parent.name for p in (REPO_ROOT / "workflows").glob("*/workflow.yaml")
)


def _phase(**extra):
    return _parse_phase(
        {"id": "reproduce", "impl": "tooling/reproduce", **extra}, index=0
    )


def _skill(root: Path, *parts: str) -> Path:
    path = root.joinpath(*parts, "SKILL.md")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("---\nname: x\ndescription: d\n---\n\nbody\n", encoding="utf-8")
    return path


class TestParsing:
    def test_companions_keep_their_order_and_one_line_cases(self):
        phase = _phase(
            companions={
                "hermes/python-debugpy": "the defect is\n  in Python",
                "hermes/systematic-debugging": "the cause is hidden",
            }
        )
        assert phase.companions == (
            ("hermes/python-debugpy", "the defect is in Python"),
            ("hermes/systematic-debugging", "the cause is hidden"),
        )

    def test_a_phase_without_companions_has_none(self):
        assert _phase().companions == ()

    @pytest.mark.parametrize(
        ("raw", "message"),
        [
            (["hermes/spike"], "must be a mapping"),
            ({"spike": "x"}, "'<pack>/<skill>'"),
            ({"tooling/reproduce": "x"}, "the impl itself"),
            ({"hermes/spike": ""}, "needs the case"),
            ({"hermes/spike": None}, "needs the case"),
        ],
    )
    def test_a_malformed_companion_is_refused(self, raw, message):
        with pytest.raises(WorkflowError, match=message):
            _phase(companions=raw)


class TestLines:
    def test_the_named_pack_wins_over_the_flat_build_output(self, tmp_path):
        """`.agents/skills/` is flat by name: it may hold another pack's
        `systematic-debugging`. The companion names hermes's."""
        source = _skill(tmp_path, "skills", "hermes", "systematic-debugging")
        _skill(tmp_path, ".agents", "skills", "systematic-debugging")
        phase = _phase(companions={"hermes/systematic-debugging": "it is hidden"})

        assert companion_lines(phase, tmp_path) == [
            f"  - when it is hidden: `{source.resolve()}`"
        ]

    def test_the_build_output_stands_in_for_an_absent_source(self, tmp_path):
        built = _skill(tmp_path, ".agents", "skills", "python-debugpy")
        phase = _phase(companions={"hermes/python-debugpy": "Python"})
        assert companion_lines(phase, tmp_path) == [f"  - when Python: `{built}`"]

    def test_a_companion_missing_from_disk_is_left_out(self, tmp_path):
        phase = _phase(companions={"hermes/python-debugpy": "Python"})
        assert companion_lines(phase, tmp_path) == []

    def test_the_prompt_offers_them_after_the_procedure_header(self, tmp_path):
        source = _skill(tmp_path, "skills", "hermes", "python-debugpy")
        phase = _phase(companions={"hermes/python-debugpy": "Python"})
        spec = tmp_path / "spec"
        spec.mkdir()
        ctx = PhaseContext(
            project_dir=tmp_path, spec_dir=spec, model="m", repo_root=tmp_path
        )
        resolved = SimpleNamespace(
            phase=phase, dispatch="fresh-context", degraded_from=None, reason=""
        )

        prompt = _build_prompt(resolved, "Write the failing test.", ctx)

        assert "COMPANION PROCEDURES" in prompt
        assert f"  - when Python: `{source.resolve()}`" in prompt
        assert prompt.index("COMPANION PROCEDURES") < prompt.index(
            "Write the failing test."
        )

    def test_no_companion_no_section(self, tmp_path):
        spec = tmp_path / "spec"
        spec.mkdir()
        ctx = PhaseContext(
            project_dir=tmp_path, spec_dir=spec, model="m", repo_root=tmp_path
        )
        resolved = SimpleNamespace(
            phase=_phase(), dispatch="fresh-context", degraded_from=None, reason=""
        )
        assert "COMPANION" not in _build_prompt(resolved, "body", ctx)


class TestCommittedWorkflows:
    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_every_companion_is_committed_in_the_pack_it_names(self, name):
        """On a fresh clone, from the source tree: what a sync removes is red."""
        workflow = load_workflow(REPO_ROOT / "workflows" / name / "workflow.yaml")
        for phase in workflow.phases:
            for impl, _when in phase.companions:
                pack, _, skill = impl.partition("/")
                assert (REPO_ROOT / "skills" / pack / skill / "SKILL.md").is_file(), (
                    name,
                    phase.id,
                    impl,
                )

    @pytest.mark.parametrize("name", WORKFLOWS)
    def test_companions_sit_only_on_phases_that_open_a_session(self, name):
        """A builtin or elsewhere-run phase never builds this prompt: a
        companion there would be printed and read by nobody."""
        not_a_session = BUILTIN_EXECUTORS | _ELSEWHERE | DETERMINISTIC_EXECUTORS
        workflow = load_workflow(REPO_ROOT / "workflows" / name / "workflow.yaml")
        for phase in workflow.phases:
            if phase.companions:
                assert phase.id not in not_a_session, (name, phase.id)

    @pytest.mark.parametrize("name", ["bug-fix", "hotfix"])
    def test_reproducing_a_bug_offers_the_hermes_debuggers(self, name):
        workflow = load_workflow(REPO_ROOT / "workflows" / name / "workflow.yaml")
        offered = {impl for impl, _ in workflow.phase("reproduce").companions}
        assert offered == {
            "hermes/systematic-debugging",
            "hermes/python-debugpy",
            "hermes/node-inspect-debugger",
        }

    def test_an_investigation_offers_systematic_debugging(self):
        workflow = load_workflow(
            REPO_ROOT / "workflows" / "investigation" / "workflow.yaml"
        )
        offered = {impl for impl, _ in workflow.phase("investigate").companions}
        # Not the debuggers: the phase runs under the read-only analyzer.
        assert offered == {"hermes/systematic-debugging"}
