# Agent prompts

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Agent Prompts (`apps/backend/prompts/`)

28 root-level prompts + 16 GitHub-specific prompts in `prompts/github/`, plus the
MCP-tool sections in `prompts/mcp_tools/` and `prompts/teams/`.

| Category | Prompts |
|----------|---------|
| **Core Build** | planner.md, followup_planner.md — the coder has no prompt file, see below |
| **QA** | qa_reviewer.md, qa_fixer.md, validation_fixer.md |
| **Spec Pipeline** | spec_researcher.md, spec_writer.md, spec_critic.md, spec_quick.md, complexity_assessor.md |
| **Ideation** | ideation_code_improvements.md, ideation_code_quality.md, ideation_documentation.md, ideation_performance.md, ideation_security.md, ideation_ui_ux.md |
| **Incidents** | incident_cicd_analyzer.md, incident_proactive_analyzer.md, incident_production_responder.md |
| **Analysis** | architecture_reviewer.md, architecture_visualizer.md, architecture_map_delta.md, architecture_map_repair.md, insight_extractor.md, learning_analyzer.md |
| **Roadmap** | roadmap_discovery.md, roadmap_features.md, competitor_analysis.md |
| **GitHub** | issue_triager.md, pr_reviewer.md, pr_parallel_orchestrator.md, pr_finding_validator.md, pr_template_filler.md, pr_ai_triage.md, pr_codebase_fit_agent.md, pr_security_agent.md, pr_quality_agent.md, pr_logic_agent.md, pr_structural.md, pr_followup.md, pr_followup_orchestrator.md, pr_followup_resolution_agent.md, pr_followup_newcode_agent.md, pr_followup_comment_agent.md |

**Every prompt in this table has a loader.** Eleven did not (audit F10, lot L10):
`coder_recovery.md`, `intent_templates.md`, `environment_cloner.md`,
`performance_profiler.md`, `documentation_agent.md`, `code_migration.md`,
`multi_repo_planner.md`, `breaking_change_detector.md`, `browser_agent.md`,
`github/pr_orchestrator.md` and `github/issue_analyzer.md` — about 51 KB that no
code, workflow, skill or frontend file loaded by name or by a dynamic path. The
features they were named after (documentation agent, performance profiler,
browser agent, code migration, multi-repo) run from their own runners, which
never read them. Before adding a prompt, add the line that loads it.

**The coder's prompt is assembled, not loaded.** `coder.md` (35 KB) was the
twelfth orphan: since the coder loop moved to one session per subtask, each
session is prompted by `prompts_pkg.prompt_generator.generate_subtask_prompt`
— an effort preamble (`workflows.runner.effort_preamble`: effort, methodology
path, dispatch), the environment, the subtask, its files and verification —
and `get_coding_prompt`, the only reader of `coder.md`, had no caller. The
"STEP 6.5 self-critique" the file prescribed after every subtask was therefore
never asked of any model. What the assembled prompt carries depends on the
stack: the `.NET Build Tools` section only in a project with C#/F#/VB project
files, the stack-aware test plan only for the files a subtask touches, the UI
rules (`uiux_section`) only on subtasks whose files are UI.
`tests/test_coder_prompt_assembly.py` holds the assembly to that.

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

**Artifacts are written once.** The build prompts ask for the fields the
orchestrator reads and nothing more: the QA reviewer records `qa_signoff` and a
`Verdict:` line, and `qa_report.md` / `QA_FIX_REQUEST.md` are rendered from it;
the planner no longer writes `verification_strategy`, `qa_acceptance` or a
narrative `build-progress.txt`. The shared rules live in
`core/llm_optimization.ARTIFACT_RULES`; see
[context-management.md](context-management.md).
