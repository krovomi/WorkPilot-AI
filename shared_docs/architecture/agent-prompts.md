# Agent prompts

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Agent Prompts (`apps/backend/prompts/`)

37 root-level prompts + 18 GitHub-specific prompts in `prompts/github/`.

| Category | Prompts |
|----------|---------|
| **Core Build** | planner.md, coder.md, coder_recovery.md |
| **QA** | qa_reviewer.md, qa_fixer.md, validation_fixer.md |
| **Spec Pipeline** | spec_gatherer.md, spec_researcher.md, spec_writer.md, spec_critic.md, spec_quick.md, complexity_assessor.md |
| **Ideation** | ideation_code_improvements.md, ideation_code_quality.md, ideation_documentation.md, ideation_performance.md, ideation_security.md, ideation_ui_ux.md |
| **Incidents** | incident_cicd_analyzer.md, incident_proactive_analyzer.md, incident_production_responder.md |
| **Analysis** | architecture_reviewer.md, architecture_visualizer.md, breaking_change_detector.md, performance_profiler.md, insight_extractor.md, learning_analyzer.md |
| **Advanced** | browser_agent.md, code_migration.md, documentation_agent.md, environment_cloner.md, multi_repo_planner.md, intent_templates.md, followup_planner.md |
| **Roadmap** | roadmap_discovery.md, roadmap_features.md, competitor_analysis.md |
| **GitHub** | issue_analyzer.md, issue_triager.md, pr_reviewer.md, pr_orchestrator.md, pr_parallel_orchestrator.md, pr_finding_validator.md, pr_template_filler.md, pr_ai_triage.md, pr_codebase_fit_agent.md, + 9 more |

**A spec prompt runs under the config its work needs.** Every LLM phase of the
spec pipeline used to run as `spec_writer`, whatever the prompt.
`spec/pipeline/agent_runner.py::PROMPT_AGENT_TYPES` now names the two that need
more:

| Prompt | `agent_type` | Why |
|---|---|---|
| `spec_researcher.md` | `spec_researcher` | checks each integration against Context7 and the web — `spec_writer` has neither — and writes `research.json` |
| `spec_critic.md` | `spec_self_critique` | rewrites `spec.md` and writes `critique_report.json`, checking library claims against Context7 |
| everything else | `spec_writer` | they write files, and `planner.md` / `spec_quick.md` ask for the `Write` tool non-Claude providers only expose under `planner` and `spec_writer` |

A read-only config is the wrong fix for a prompt that writes its output, and the
failure used to be silent: with no file on disk the phase stood a placeholder in
(`create_minimal_research`, `create_minimal_critique`) and reported success.
`spec_critic` itself stays read-only — it is what the workflow's `brainstorm` runs
under. `tests/test_spec_agent_configuration.py` reads each prompt the pipeline
runs from its call site and checks its config grants what the prompt uses.

**A phase that produced nothing says so.** The pipeline still moves on when the
researcher or the critic writes no file, or fails every attempt — what changed
is that nothing pretends otherwise:

| Where | What it says |
|---|---|
| the file | `"placeholder": true` (`validator.is_placeholder`; an unreadable file counts as one). A placeholder critique no longer claims `no_issues_found: true` — nobody looked |
| the resume | a resumed build runs research and self-critique again over a placeholder, where it used to skip them because a file existed |
| `PhaseResult.warnings` | the reason, beside the `errors` a successful result may carry |
| the task log | `orchestrator._report_phase_warnings` writes each one (`phase_notes`) as a `LogEntryType.WARNING` entry of the planning phase, rendered as an amber row in the Logs tab. The orchestrator used to drop the `errors` of a successful result |

The quick spec's `create_minimal_plan` stand-in is reported the same way. The
task card itself shows nothing yet: the Logs tab is where the warning is read.

Duplicate detection and issue auto-fix are listed as features above but are not
prompt-driven: `runners/github/duplicates.py` compares embeddings, and
`runners/github/orchestrator.py` drives `auto_fix_issue`. The
`duplicate_detector.md` and `pr_fixer.md` this table used to name were left over
from an earlier design and loaded by nothing.
