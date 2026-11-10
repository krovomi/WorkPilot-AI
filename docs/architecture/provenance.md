# Provenance dossier of a pull request (prospective P5)

The EU Cyber Resilience Act (regulation (EU) 2024/2847) requires reporting
exploited vulnerabilities from 11 September 2026 and documenting components
from 11 December 2027; the AI Act adds its own traceability duties. "Who wrote
this code, with which model, from which dependencies, checked how?" becomes an
audit question. Every answer already exists in the task: `provenance/` gathers
them into one dossier per pull request.

## What it holds

| Part | Source | Absent when |
|---|---|---|
| Attribution | Agent Trace summary (`agent_trace.summarize`, F3): lines added by an agent, a person, nobody known; the models | no session record |
| Dependencies | the dependency guard's record (`dependency_guard.json`, F2): each added package and its verdict | the guard did not run |
| SBOM of the diff | `dependency_guard.added_packages` against the merge base, as CycloneDX 1.6 with one package URL per component: npm, PyPI, NuGet, Maven, Cargo, Go, Composer, pub, RubyGems | no base found |
| Gates | `hard_gates.json`, written by the build after `evaluate_hard_gates` (`workflows/hard_gates.py`) | the build did not reach the gates |
| Verification | `verify/verify.json`: status, reason, score | no verification ran |

A part whose source is absent is `null`, never guessed. Manifests declare
names, not resolved versions, so an SBOM component carries no `version` rather
than a guessed one; a lock-file reader can add them later without changing the
format. The dossier holds paths, counts, package names, verdicts and model
names only: no code, no prompt, no secret.

## Where it goes

- `worktree_pr._with_provenance` writes it when the PR body is built, after the
  Agent Trace line: `dossier.json`, `sbom.cdx.json` and `dossier.md` in
  `<project>/.workpilot/specs/<spec>/provenance/`, the copy that survives the
  merge (the worktree's is deleted with it). Each source is read from the
  worktree's copy first, then the project's. A linked `provenance/` folder is
  refused.
- The PR body carries a folded `<details>` block of four lines: attribution,
  dependencies added and the guard's verdict, each gate, the verification.
- The compliance collector (`compliance_collector/evidence.py`) reads each
  task's dossier as a dated change; the review, gates and guard records it
  reads from the task itself ([compliance-evidence.md](compliance-evidence.md)).

Building the dossier never fails a build or a PR: a git or disk error leaves
the body as it was.
