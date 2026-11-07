"""Enforcing the gates a workflow says are not negotiable.

`hard_gate: tests-pass` was declared on the `verify` phase and applied nowhere.
The flag did one thing — kept the phase out of the effort pruner — and the
docstring said "tests passing is not negotiable" while nothing checked whether
they passed. A build could conclude green with a red suite.

What a hard gate is, and is not
-------------------------------
It is a **claim about the build's outcome**, evaluated from evidence the build
already produced. It is not a phase that runs an agent: `verify`'s
implementation is a skill that tells a model how to check its work, and that
still runs through the ordinary pipeline. This module answers the separate
question the flag was always making — *did it actually hold?*

Unknown is not a pass, and not a failure either
-----------------------------------------------
A QA report that does not say whether tests ran leaves the gate `None`. That is
deliberate and it is the same rule as everywhere else in this refactor: the
build is not blocked on an absent signal, and the absent signal is never
recorded as corroboration. A gate that could not be evaluated is reported as
such, loudly enough that someone notices the evidence is missing.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "HardGateResult",
    "HardGateReport",
    "evaluate_hard_gates",
    "gate_names",
    "TESTS_PASS",
    "APP_VERIFIED",
    "TESTS_UNCHANGED",
    "DEPS_EXIST",
    "PROOF_CHECKS",
    "TESTS_BITE",
    "is_test_file",
    "GATE_RECORD",
    "load_gate_record",
    "write_gate_record",
]

#: What the gates said at the end of the build, for the provenance dossier
#: (`provenance/`): written by the build, never by an agent.
GATE_RECORD = "hard_gates.json"

TESTS_PASS = "tests-pass"  # pragma: allowlist secret

# The verification loop's verdict (`verify/record.py`): the application the
# task changed was launched, showed no error, and reached the changed state.
# Read from `<spec_dir>/verify/verify.json`, the one record every reader
# shares; a replay after QA that regressed has already turned it to `fail`.
APP_VERIFIED = "app-verified"


# A refactoring's promise: the behaviour is unchanged, and the proof is that
# the tests that pinned it are the same tests. Held when the task's diff
# touches no test file; unknown when the change set is not known. Deterministic
# and free, so it runs on every provider.
TESTS_UNCHANGED = "tests-unchanged"

# Every package the task added exists on its registry: the dependency guard's
# record (`<spec_dir>/dependency_guard.json`, written by the QA gate). Unknown
# when the guard did not run, could not ask a registry or a private feed may
# serve the package; a 404 from the public registry is the only failure.
DEPS_EXIST = "deps-exist"

# The project's proof checkers (Dafny, Lean, Verus, F*…) accept the proofs
# with the task's changes: `<spec_dir>/proof_checks.json`, written by the QA
# gate. A project that declares no checker is not concerned and gets no line;
# a checker missing, a time out or an unapproved recipe is unknown.
PROOF_CHECKS = "proof-checks"

# The tests catch a bug planted in the lines the task wrote: the mutation
# gate's record (`<spec_dir>/mutation_gate.json`, written by the QA gate,
# `qa/mutation_gate.py`). Unknown when the gate did not run, was switched off,
# or could not measure (no test command, a red suite, the time budget).
TESTS_BITE = "tests-bite"

_TEST_DIRS = ("tests", "test", "__tests__", "spec", "specs", "e2e")
# `test_x.py`, `x_test.go`, `x.test.ts`, `x.spec.ts`, `x_spec.rb`, `x-test.js`:
# the word `test`/`spec` as a whole segment of the file name.
_TEST_SEGMENT = re.compile(r"(?:^|[._-])(?:test|tests|spec)(?:[._-]|$)")
# `FooTests.cs`, `FooTest.java`, `FooSpec.kt`: a CamelCase suffix.
_TEST_SUFFIX = re.compile(r"[a-z0-9](?:Test|Tests|Spec)$")


def is_test_file(path: str) -> bool:
    """Whether a path is, by the conventions of the usual stacks, a test.

    `tests/`, `__tests__/`, `spec/` anywhere in the path; `test_x.py`,
    `x_test.go`, `x.test.ts`, `x.spec.ts`, `FooTests.cs`, `x_spec.rb` by
    name. `contest.py` and `testing_utils.py` are not tests. A conservative
    list: a file this misses makes the gate hold when it should not, which
    is the lesser error only because the reviewer still sees the diff.
    """
    normalised = str(path).replace("\\", "/")
    parts = normalised.split("/")
    if any(part.lower() in _TEST_DIRS for part in parts[:-1]):
        return True
    name = parts[-1]
    stem = name.rsplit(".", 1)[0] if "." in name else name
    if _TEST_SEGMENT.search(name.lower()):
        return True
    return bool(_TEST_SUFFIX.search(stem))


def _tests_unchanged(changed_files: list[str] | None) -> tuple[bool | None, str]:
    if changed_files is None:
        return None, "the change set is not known"
    touched = sorted({p for p in changed_files if is_test_file(p)})
    if not touched:
        return True, "no test file in the diff"
    shown = ", ".join(touched[:5]) + (" …" if len(touched) > 5 else "")
    return False, f"the diff touches {len(touched)} test file(s): {shown}"


def gate_names(declared: str | None) -> list[str]:
    """``"tests-pass,app-verified"`` -> ``["tests-pass", "app-verified"]``."""
    return [g.strip() for g in str(declared or "").split(",") if g.strip()]


def _app_verified(spec_dir: Path) -> tuple[bool | None, str]:
    try:
        from verify.record import load_record
    except ImportError as exc:  # pragma: no cover - import-time environment
        return None, f"the verification module is unavailable: {exc}"
    record = load_record(Path(spec_dir) / "verify")
    if record is None:
        return None, "no verification record — the verify phase did not run"
    status = record.get("status")
    reason = str(record.get("reason") or "")
    if status == "pass":
        score = record.get("score")
        return True, f"score {score}/100" if score is not None else ""
    if status == "fail":
        return False, reason or "the verification failed"
    return None, f"{status}" + (f" — {reason}" if reason else "")


def _deps_exist(spec_dir: Path) -> tuple[bool | None, str]:
    try:
        from dependency_guard import load_record
    except ImportError as exc:  # pragma: no cover - import-time environment
        return None, f"the dependency guard is unavailable: {exc}"
    record = load_record(spec_dir)
    if record is None:
        return None, "no dependency record — the QA dependency check did not run"
    findings = [f for f in record.get("findings") or [] if isinstance(f, dict)]

    def names(verdict: str) -> str:
        return ", ".join(
            str(f.get("name")) for f in findings if f.get("verdict") == verdict
        )

    status = record.get("status")
    if status == "blocked":
        return False, f"not on their registry: {names('blocked')}"
    if status == "pass":
        checked = sum(1 for f in findings if f.get("verdict") in ("ok", "warn"))
        return True, (
            f"{checked} new package(s) found on their registry"
            if checked
            else "no new dependency"
        )
    detail = (
        record.get("unchecked")
        or names("unknown")
        or ", ".join(record.get("unreadable") or [])
    )
    return None, f"unknown — {detail}" if detail else "unknown"


def _proof_checks(spec_dir: Path) -> tuple[bool | None, str] | None:
    """The proof record's verdict; None when the project declares no proof."""
    try:
        from core.workspace.proofs import load_proof_record
    except ImportError as exc:  # pragma: no cover - import-time environment
        return None, f"the proof checks are unavailable: {exc}"
    record = load_proof_record(spec_dir)
    if record is None:
        return None, "no proof record — the QA proof check did not run"
    status = record.get("status")
    reason = str(record.get("reason") or "")
    if status == "none":
        return None
    if status == "pass":
        return True, reason
    if status == "fail":
        return False, reason or "a proof checker rejected the proofs"
    return None, f"unknown — {reason}" if reason else "unknown"


def _tests_bite(spec_dir: Path) -> tuple[bool | None, str]:
    try:
        from mutation_gate import load_record
    except ImportError as exc:  # pragma: no cover - import-time environment
        return None, f"the mutation gate is unavailable: {exc}"
    record = load_record(spec_dir)
    if record is None:
        return None, "no mutation record — the QA mutation gate did not run"
    status = record.get("status")
    reason = str(record.get("reason") or "")
    score = record.get("score")
    measured = f"score {score}% (threshold {record.get('threshold')}%)"
    if status == "pass":
        return True, measured if score is not None else reason
    if status == "fail":
        survivors = [
            f"{r.get('path')}:{r.get('line')}"
            for r in record.get("results") or []
            if isinstance(r, dict) and r.get("outcome") == "survived"
        ]
        return False, f"{measured}; survived: {', '.join(survivors[:5])}"
    return None, f"unknown — {reason}" if reason else "unknown"


@dataclass(frozen=True)
class HardGateResult:
    phase_id: str
    gate: str
    held: bool | None
    """None when the evidence to decide was not there."""
    detail: str = ""

    def describe(self) -> str:
        if self.held is None:
            return f"  ?  {self.phase_id}: {self.gate} — {self.detail or 'no evidence'}"
        mark = "✓" if self.held else "✗"
        return f"  {mark}  {self.phase_id}: {self.gate}" + (
            f" — {self.detail}" if self.detail else ""
        )


@dataclass
class HardGateReport:
    results: list[HardGateResult] = field(default_factory=list)

    @property
    def failed(self) -> list[HardGateResult]:
        return [r for r in self.results if r.held is False]

    @property
    def unknown(self) -> list[HardGateResult]:
        return [r for r in self.results if r.held is None]

    @property
    def blocking(self) -> bool:
        """Whether a gate was evaluated and did not hold.

        Only a definite failure blocks. An unevaluable gate is surfaced but
        does not stop a build that may be perfectly fine — refusing on missing
        evidence would make every project without a QA report unbuildable.
        """
        return bool(self.failed)

    def describe(self) -> str:
        if not self.results:
            return ""
        head = "Hard gates:"
        if self.blocking:
            head = "Hard gates — NOT MET:"
        return "\n".join([head, *(r.describe() for r in self.results)])


def write_gate_record(spec_dir: Path, report: HardGateReport) -> None:
    """Keep the report next to the spec. Never raises: a gate reports."""
    data = {
        "at": time.time(),
        "blocking": report.blocking,
        "results": [asdict(r) for r in report.results],
    }
    try:
        (Path(spec_dir) / GATE_RECORD).write_text(json.dumps(data), encoding="utf-8")
    except OSError as exc:
        logger.debug("hard gate record not written: %s", exc)


def load_gate_record(spec_dir: Path) -> dict | None:
    try:
        data = json.loads((Path(spec_dir) / GATE_RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def evaluate_hard_gates(
    profile,
    spec_dir: Path,
    *,
    tests_passed: bool | None = None,
    changed_files: list[str] | None = None,
):
    """Check every hard gate the profile kept, against what the build produced.

    ``tests_passed`` is the caller's reading of the test evidence — the same
    value `observe` records — so the two agree by construction rather than by
    two parsers happening to say the same thing. ``changed_files`` is the
    task's real diff, for the gates that are claims about it.

    Never raises. A gate reports; the caller decides what a failure means.
    """
    report = HardGateReport()
    try:
        for resolved in profile.run:
            for gate in gate_names(resolved.phase.hard_gate):
                _evaluate_one(
                    report, resolved, gate, spec_dir, tests_passed, changed_files
                )
    except Exception as exc:  # noqa: BLE001 - a gate reports, it does not crash
        logger.warning("hard gate evaluation failed: %s", exc)
    return report


def _evaluate_one(
    report, resolved, gate: str, spec_dir: Path, tests_passed, changed_files=None
) -> None:
    """One named gate of one phase, appended to ``report``."""
    if gate == APP_VERIFIED:
        held, detail = _app_verified(spec_dir)
        report.results.append(
            HardGateResult(phase_id=resolved.id, gate=gate, held=held, detail=detail)
        )
    elif gate == TESTS_UNCHANGED:
        held, detail = _tests_unchanged(changed_files)
        report.results.append(
            HardGateResult(phase_id=resolved.id, gate=gate, held=held, detail=detail)
        )
    elif gate == DEPS_EXIST:
        held, detail = _deps_exist(spec_dir)
        report.results.append(
            HardGateResult(phase_id=resolved.id, gate=gate, held=held, detail=detail)
        )
    elif gate == PROOF_CHECKS:
        verdict = _proof_checks(spec_dir)
        if verdict is not None:
            held, detail = verdict
            report.results.append(
                HardGateResult(
                    phase_id=resolved.id, gate=gate, held=held, detail=detail
                )
            )
    elif gate == TESTS_BITE:
        held, detail = _tests_bite(spec_dir)
        report.results.append(
            HardGateResult(phase_id=resolved.id, gate=gate, held=held, detail=detail)
        )
    elif gate == TESTS_PASS:
        report.results.append(
            HardGateResult(
                phase_id=resolved.id,
                gate=gate,
                held=tests_passed,
                detail=(
                    ""
                    if tests_passed
                    else "the QA report does not record a passing test run"
                    if tests_passed is None
                    else "the QA report records failing tests"
                ),
            )
        )
    else:
        # An unknown gate name is reported, never silently satisfied.
        # A typo in `workflow.yaml` must not switch a gate off.
        report.results.append(
            HardGateResult(
                phase_id=resolved.id,
                gate=gate,
                held=None,
                detail=f"unknown gate {gate!r} — nothing evaluates it",
            )
        )
