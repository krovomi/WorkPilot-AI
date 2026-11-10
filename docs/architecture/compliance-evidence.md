# Compliance evidence collector

Issue #357. Page « Collecteur de preuves de conformité » (Toolbox, expérimentale),
`apps/backend/compliance_collector/`, `runners/compliance_runner.py`,
`apps/frontend/src/main/compliance/`.

## What it answers

"For this framework, which controls had evidence this month, and which did not?"
An auditor asks for proof dated within the period: who approved a change, which
tests ran, which security checks passed. WorkPilot already writes all of it
while it builds tasks; the collector reads it back, dates each item, and judges
every control of the framework with it. No model is called, on any provider:
the report is the same offline.

## Frameworks

YAML files, one per framework (`compliance_collector/catalog/`):

| id | Framework | Numbering |
|---|---|---|
| `soc2` | SOC 2 | Trust Services Criteria 2017 (points of focus 2022) |
| `iso27001` | ISO/IEC 27001 | Annex A of the 2022 edition (A.5 to A.8) |
| `hipaa` | HIPAA Security Rule | 45 CFR 164.308 to 164.316 |
| `pci_dss` | PCI DSS | v4.0, requirements 6, 7, 10, 11, 12 |

Each control has an id, a title and a recommendation in English and French, the
evidence it needs, and how old that evidence may be at the end of the period:

```yaml
  - id: CC8.1
    title: {en: Changes are authorised, tested and approved, fr: …}
    evidence: [[spec_approval, code_review], [tests], [change, merge]]
    max_age_days: 30
    recommendation: {en: …, fr: …}
```

`evidence` is a list of requirements, all needed, each met by any of its
kinds. A project adds its own in `.workpilot/compliance/frameworks/*.yaml`: a
file with the id of a bundled framework replaces it (a subset, another
numbering), another id adds one (NIST CSF, an internal policy). A project file
is data (S2): `yaml.safe_load`, 256 KB at most, every field checked; a file
that does not hold is skipped and shown on the page, never read in part.

## Evidence

`evidence.collect_evidence(root, since, until)` returns dated items (`kind`,
`at`, `title`, `source`, `outcome` pass / fail / info, `actor`, `task`):

| Kind | Read from |
|---|---|
| `spec_approval` | `review_state.json` of each task (who, when) |
| `code_review` | `qa_signoff` of `implementation_plan.json` (approved or rejected) |
| `tests` | the `tests-*` gates of `hard_gates.json`, `verify/verify.json`, `mutation_gate.json` |
| `security` | `dependency_guard.json`, `red_team.json`, `security_scan_results.json` |
| `change`, `merge` | git commits of the period; a merge commit or a squash `(#123)` is a reviewed merge; the provenance dossier |
| `release` | git tags of the period |
| `access`, `policy`, `procedure`, `security_config`, `monitoring`, `deployment` | the configuration in place, every stack and CI (CODEOWNERS, SECURITY.md, runbooks, Dependabot / Renovate / Snyk / Trivy / CodeQL, Prometheus / Sentry / OpenTelemetry / Serilog, GitHub Actions / GitLab / Azure / Jenkins / Docker / Helm / Terraform…), dated by its last commit |
| `incident` | `.workpilot/incidents/*.json` (`title`, `detected_at`, `resolved_at`) or `.md`, `docs/incidents/`, `docs/postmortems/` |

The task records are read from `.workpilot/specs/*/` by file name;
`SPEC_RECORDS` names them and a test holds each name equal to the constant of
the module that writes it. Nothing is followed through a link. An item holds
names, dates, verdicts and paths, never code.

## Verdicts and gaps

`report.build_report` judges each requirement of each control at the end of
the period: **covered** (evidence young enough), **failing** (only failed checks
within the age: a rejected review, a failed test, a blocked dependency),
**stale** (evidence, older than `max_age_days`), **missing** (none). A control
takes its worst requirement. A control is **alerted** when nothing has
evidenced it for more than 30 days. The report carries:

- the coverage (covered / controls) and an executive summary computed from the
  evidence: approvals, reviews approved and rejected, tests, security findings,
  tasks, the risks (missing and failing controls);
- the gaps, each with the kinds it lacks and its recommendation;
- per control, the evidence of the period (25 listed, all counted) or the last
  older item;
- the mapping it was judged with, so a report saved before a framework changed
  reads as it was written.

## Reports, monthly run, alerts

A report is saved as `.workpilot/compliance/reports/<framework>-<YYYY-MM>.json`
(WorkPilot's folder, ignored by git: nothing of the project's code is touched).
The page ticks "monthly report" per framework, saved in
`.workpilot/compliance/config.json`. The main process
(`main/compliance/monthly.ts`) checks every project three minutes after start,
then every six hours: when last month's report of a chosen framework is not
saved, the runner makes it (`--monthly`), and a control alerted is announced on
the desktop and on the person's ntfy or Telegram channel
(`notificationService.announce`, under the "review needed" switch). A report
already saved is never rewritten by the monthly run.

## Exports

JSON is the report as the collector wrote it, kept in main (the renderer
never supplies an audit file's data). CSV, HTML and PDF are the tables the
renderer worded in the app's language; main reads them as untrusted strings:
CSV cells are quoted and a leading `=`, `+`, `-`, `@` is defused, the HTML is
escaped with a CSP allowing no script, and the PDF is printed from that page in
a hidden window with JavaScript off.

## Trust boundaries

Every IPC channel takes a project the person added (`resolveKnownProject`)
and checked values only: a framework id, a month, a report file name, a config
of known shape (written to a temporary file passed to the runner). The runner
runs without a shell.

## Not done

- SSO logins, role changes and admin actions: the server mode's audit log is
  not read yet; access controls are evidenced by CODEOWNERS only.
- Deployments run outside the repository (cloud consoles, CD tools): only the
  pipelines versioned in the repository and the release tags are evidence.
- A model-written executive summary: the summary is computed, the same on
  every provider and offline.
- Restricting the page to a compliance officer and encrypting the reports at
  rest: the reports hold names and dates of the project's own history, stored
  where the project is.
