"""One review, with lenses the effort chooses — and few sessions re-reading the diff.

Audit F11 counted up to seven sessions reading the same diff at `ultrathink`.
Lot L6 folded `adversarial-review` and `spec-conformance` into the lenses of
`review`; lot L10 has the engine pick the lenses, takes the review roster away
from a phase whose lenses already ask its specialists' questions, and pins the
count below.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from workflows.runner import (  # noqa: E402
    CONDITIONAL_LENSES,
    REVIEW_LENSES,
    REVIEW_LENSES_BY_EFFORT,
    PhaseContext,
    _build_prompt,
    review_lenses,
)
from workflows.spec import EFFORT_ORDER  # noqa: E402

from workflows import load_workflow, resolve_profile  # noqa: E402

WORKFLOW = load_workflow(REPO_ROOT / "workflows" / "feature-build" / "workflow.yaml")
SKILL = REPO_ROOT / "skills" / "tooling" / "review-lenses" / "SKILL.md"

# The build's sessions that read the task's diff after it is written, and the
# lowest effort at which each one opens a session. `verify` runs at every
# effort, but its `verifier` session only from `medium` (`verify.loop`); `qa`
# counts its first pass — later passes are bounded by the QA budget (F17).
# `analyze`, `brainstorm` and `mobile-design` run before any code exists;
# `design-check` and `verify-replay` call no model.
DIFF_READERS = {
    "review": "medium",
    "verify": "medium",
    "qa": "none",
    "architecture-map": "medium",
}

CODE_TASK = ["src/orders/service.py", "src/orders/api.py"]
MOBILE_TASK = [*CODE_TASK, "android/app/src/main/AndroidManifest.xml"]


def _readers(effort: str, changed: list[str]) -> list[str]:
    profile = resolve_profile(WORKFLOW, effort, changed_files=changed)
    ran = {r.id for r in profile.run}
    return [
        pid
        for pid, floor in DIFF_READERS.items()
        if pid in ran and EFFORT_ORDER.index(effort) >= EFFORT_ORDER.index(floor)
    ]


class TestDiffReaders:
    def test_every_effort_rereads_the_diff_at_most_four_times(self):
        for effort in EFFORT_ORDER:
            assert len(_readers(effort, CODE_TASK)) <= 4, effort

    def test_ultrathink_on_a_code_task(self):
        assert _readers("ultrathink", CODE_TASK) == [
            "review",
            "verify",
            "qa",
            "architecture-map",
        ]

    def test_a_mobile_task_reads_it_four_times_too(self):
        # `store-readiness` was a fifth session after QA; it is lens 5 of
        # `review` now (see TestLenses).
        assert len(_readers("ultrathink", MOBILE_TASK)) == 4

    def test_the_low_efforts_read_it_once(self):
        assert _readers("none", CODE_TASK) == ["qa"]
        assert _readers("low", CODE_TASK) == ["qa"]

    def test_the_review_phase_delegates_to_nobody(self):
        review = next(p for p in WORKFLOW.phases if p.id == "review")
        assert review.roster == "solo"


class TestLenses:
    def test_every_effort_names_its_lenses(self):
        assert set(REVIEW_LENSES_BY_EFFORT) == set(EFFORT_ORDER)

    def test_more_effort_only_adds_lenses(self):
        previous: set[int] = set()
        for effort in EFFORT_ORDER:
            lenses = set(review_lenses(effort))
            assert previous <= lenses, effort
            previous = lenses
        assert previous == set(REVIEW_LENSES)

    def test_the_skill_table_says_the_same(self):
        # The skill's table is what a model reads when the LENSES line is
        # absent (a provider override, a run outside the engine).
        text = SKILL.read_text(encoding="utf-8")
        rows = re.findall(r"^\| (\d)\. [^|]+\|([^\n]+)$", text, re.MULTILINE)
        assert rows, "lens table not found in the skill"
        columns = ("medium", "high", "ultrathink")
        for number, cells in rows:
            marks = [c.strip() for c in cells.split("|")[: len(columns)]]
            for effort, mark in zip(columns, marks, strict=True):
                assert (int(number) in review_lenses(effort)) == (mark == "✔"), (
                    number,
                    effort,
                )

    @pytest.mark.parametrize("effort", ["medium", "high", "ultrathink"])
    def test_the_prompt_names_the_lenses(self, tmp_path, effort):
        profile = resolve_profile(WORKFLOW, effort, changed_files=CODE_TASK)
        review = next(r for r in profile.run if r.id == "review")
        spec = tmp_path / "spec"
        spec.mkdir()
        ctx = PhaseContext(
            project_dir=tmp_path,
            spec_dir=spec,
            model="m",
            repo_root=tmp_path,
            effort=effort,
            changed_files=CODE_TASK,
        )
        prompt = _build_prompt(review, "body", ctx)
        line = next(x for x in prompt.splitlines() if x.startswith("LENSES: "))
        named = [int(n) for n in re.findall(r"(\d)\. ", line)]
        assert named == list(review_lenses(effort))

    def test_no_other_phase_is_told_lenses(self, tmp_path):
        profile = resolve_profile(WORKFLOW, "high", changed_files=CODE_TASK)
        analyze = next(r for r in profile.run if r.id == "analyze")
        spec = tmp_path / "spec"
        spec.mkdir()
        ctx = PhaseContext(
            project_dir=tmp_path,
            spec_dir=spec,
            model="m",
            repo_root=tmp_path,
            effort="high",
        )
        assert "LENSES:" not in _build_prompt(analyze, "body", ctx)


class TestTheStoreLens:
    def _prompt(self, tmp_path, changed):
        profile = resolve_profile(WORKFLOW, "medium", changed_files=changed)
        review = next(r for r in profile.run if r.id == "review")
        spec = tmp_path / "spec"
        spec.mkdir()
        ctx = PhaseContext(
            project_dir=tmp_path,
            spec_dir=spec,
            model="m",
            repo_root=REPO_ROOT,
            effort="medium",
            changed_files=changed,
        )
        return _build_prompt(review, "body", ctx)

    def test_every_declared_lens_is_known(self):
        for phase in WORKFLOW.phases:
            for name, globs in phase.conditional_lenses:
                assert name in CONDITIONAL_LENSES, (phase.id, name)
                assert globs, (phase.id, name)

    def test_a_phone_change_gets_the_store_lens_and_its_procedure(self, tmp_path):
        prompt = self._prompt(tmp_path, MOBILE_TASK)
        line = next(x for x in prompt.splitlines() if x.startswith("LENSES: "))
        assert "5. Publication mobile" in line
        procedure = next(x for x in prompt.splitlines() if x.startswith("Lens 5 "))
        assert "mobile-store-readiness/SKILL.md" in procedure

    def test_a_backend_change_does_not(self, tmp_path):
        prompt = self._prompt(tmp_path, CODE_TASK)
        line = next(x for x in prompt.splitlines() if x.startswith("LENSES: "))
        assert "Publication mobile" not in line
        assert not any(x.startswith("Lens 5 ") for x in prompt.splitlines())
