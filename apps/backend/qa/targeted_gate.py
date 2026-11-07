"""The gate of the targeted QA tier: the touched tests ran, passed, and cover.

A targeted pass (`foundation.change_scope`, level ``targeted``) asks the
reviewer to run only the tests the touched files map to. Its approval stands
only when, deterministically:

- every mapped test file is recorded in ``qa_signoff.targeted_tests`` with
  ``passed: true``;
- every mapped test file appears in a shell command the reviewer ran in this
  session (the evidence its session left, whatever the provider): by its
  path or name, or, where the language runs tests by class or package, by
  its class (``dotnet test --filter FooTests``) or directory
  (``go test ./pkg/foo``);
- the coverage of the touched files reaches ``WORKPILOT_QA_MIN_COVERAGE``
  (``qa_signoff.coverage.touched_files``, and each ``per_file`` value given).

Coverage is that of the touched files, not of the diff lines alone: diff
coverage needs a tool (diff-cover and the like) most projects do not have,
while every coverage runner reports per file. Anything missing rejects: the
tier never approves a task whose tests it did not see run.

It replaces the full coverage gate for a targeted pass, which asks for unit
**and** integration coverage of the whole suite, i.e. the full run the tier
exists to avoid.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from foundation.change_scope import ChangeScope
from foundation.test_conventions import run_evidence, runs_by_name

from .coverage_gate import get_min_coverage, parse_coverage_value
from .criteria import (
    get_qa_signoff_status,
    load_implementation_plan,
    save_implementation_plan,
)

ISSUE_TYPE = "targeted_qa_gap"


def _norm(path: Any) -> str:
    text = str(path or "").replace("\\", "/").strip()
    while text.startswith("./"):
        text = text[2:]
    return text


def _recorded(signoff: dict, test: str) -> dict | None:
    entries = signoff.get("targeted_tests")
    if not isinstance(entries, list):
        return None
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        recorded = _norm(entry.get("file"))
        if (
            recorded == test
            or recorded.endswith("/" + test)
            or (test.endswith("/" + recorded) and recorded)
        ):
            return entry
    return None


def _was_run(test: str, commands: list[str]) -> bool:
    """A command named the test file (by its path or, run from a sub-folder,
    its name), or, for a language that runs tests by class, package or target
    (.NET, the JVM, Go, Rust, Swift...), the test's class or its directory
    (`foundation.test_conventions.run_evidence`)."""
    name = PurePosixPath(test).name
    if any(test in _norm(c) or name in c for c in commands):
        return True
    if not runs_by_name(test):
        return False
    evidence = run_evidence(test)
    return any(evidence.search(_norm(c)) for c in commands)


def evaluate_targeted(
    signoff: dict | None,
    scope: ChangeScope,
    commands: list[str] | None,
    min_coverage: int,
) -> list[str]:
    """The failures of a targeted approval; empty when it stands."""
    signoff = signoff if isinstance(signoff, dict) else {}
    failures: list[str] = []
    if not scope.tests:
        return ["QA ciblée sans test associé : la revue complète est requise."]
    commands = commands or []
    for test in scope.tests:
        entry = _recorded(signoff, test)
        if entry is None:
            failures.append(
                f"Test `{test}` absent de `qa_signoff.targeted_tests` : "
                "il doit être lancé et son résultat enregistré."
            )
        elif entry.get("passed") is not True:
            failures.append(f"Test `{test}` non passé ({entry.get('result', '?')}).")
        if not _was_run(test, commands):
            failures.append(
                f"Test `{test}` : aucune commande de la session ne l'a lancé."
            )
    if min_coverage > 0:
        failures.extend(_coverage_failures(signoff, scope, min_coverage))
    return failures


def _coverage_failures(signoff: dict, scope: ChangeScope, minimum: int) -> list[str]:
    coverage = signoff.get("coverage")
    coverage = coverage if isinstance(coverage, dict) else {}
    if coverage.get("measured") is False:
        return [
            "Couverture des fichiers touchés non mesurée (measured=false) — "
            f"requise : {minimum}%."
        ]
    failures: list[str] = []
    overall = parse_coverage_value(coverage.get("touched_files"))
    if overall is None:
        failures.append(
            "Couverture des fichiers touchés absente "
            f"(`qa_signoff.coverage.touched_files`) — requise : {minimum}%."
        )
    elif overall + 1e-9 < minimum:
        failures.append(
            f"Couverture des fichiers touchés {overall:.1f}% < {minimum}% requis."
        )
    per_file = coverage.get("per_file")
    if isinstance(per_file, dict):
        sources = {src for src, _ in scope.test_map}
        for path, value in per_file.items():
            pct = parse_coverage_value(value)
            if _norm(path) in sources and pct is not None and pct + 1e-9 < minimum:
                failures.append(
                    f"Couverture de `{_norm(path)}` {pct:.1f}% < {minimum}% requis."
                )
    return failures


def render_fix_request(scope: ChangeScope, failures: list[str]) -> str:
    lines = [
        "# QA Fix Request — QA ciblée",
        "",
        "**Status**: REJECTED (QA ciblée / targeted QA)",
        f"**Date**: {datetime.now(UTC).isoformat()}",
        "",
        "Cette tâche est passée en QA ciblée : seuls les tests des fichiers "
        + "modifiés sont lancés, avec la couverture de ces fichiers.",
        "",
        "## Tests associés",
        "",
        *(
            f"- `{src}` → {', '.join(f'`{t}`' for t in ts)}"
            for src, ts in scope.test_map
        ),
        "",
        "## À corriger (bloquant)",
        "",
        *(f"{i}. {f}" for i, f in enumerate(failures, start=1)),
        "",
        "## Après correctifs",
        "",
        "1. Corriger le code ou compléter les tests associés jusqu'à ce qu'ils "
        + "passent et couvrent les fichiers modifiés. Jamais de test factice "
        + "(assertion toujours vraie, test vidé) pour obtenir un chiffre.",
        "2. Mettre `ready_for_qa_revalidation: true` pour relancer la QA.",
        "",
    ]
    return "\n".join(lines)


def run_targeted_gate(
    spec_dir: Path, scope: ChangeScope, commands: list[str] | None
) -> list[dict] | None:
    """The issues that overturn a targeted approval, or None when it stands.

    On failure the sign-off is set to rejected and `QA_FIX_REQUEST.md` written,
    like the coverage gate does, so a later run cannot read a stale approval.
    """
    failures = evaluate_targeted(
        get_qa_signoff_status(spec_dir), scope, commands, get_min_coverage()
    )
    if not failures:
        return None
    issues = [
        {
            "title": "QA ciblée : tests des fichiers modifiés",
            "description": failure,
            "type": ISSUE_TYPE,
            "severity": "critical",
        }
        for failure in failures
    ]
    try:
        (spec_dir / "QA_FIX_REQUEST.md").write_text(
            render_fix_request(scope, failures), encoding="utf-8"
        )
    except OSError:
        pass  # the rejection below still stands; the fixer reads the issues
    plan = load_implementation_plan(spec_dir)
    if plan:
        signoff = plan.get("qa_signoff")
        signoff = signoff if isinstance(signoff, dict) else {}
        kept = [
            i
            for i in (
                signoff.get("issues_found")
                if isinstance(signoff.get("issues_found"), list)
                else []
            )
            if not (isinstance(i, dict) and i.get("type") == ISSUE_TYPE)
        ]
        signoff.update(
            status="rejected",
            ready_for_qa_revalidation=False,
            issues_found=[*kept, *issues],
        )
        plan["qa_signoff"] = signoff
        save_implementation_plan(spec_dir, plan)
    return issues
