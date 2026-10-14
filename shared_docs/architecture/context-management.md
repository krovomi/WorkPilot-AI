# Context management: lean artifacts, compact and clear

> Design rationale. [`docs/CLAUDE.md`](../../docs/CLAUDE.md) stays the
> normative file: where the two disagree, `docs/CLAUDE.md` wins.

A Kanban task spends its tokens in two places that nobody was watching: the
**artifacts** the agents write (output tokens, the most expensive kind), and
the **history** every new session replays (input tokens, paid again on every
turn). This page covers both.

## Artifacts: one fact, one place

Most of the prose the build agents wrote was read by nobody. The orchestrator
parses three things: the subtask fields of `implementation_plan.json`,
`qa_signoff` (`status`, `issues_found`), and a `Verdict:` line as a fallback.
Everything else was narrative, often several copies of the same thing:

| Was | Now |
|---|---|
| QA reviewer wrote the issues up to five times (`qa_report.md`, `QA_FIX_REQUEST.md`, `issues_found`, a completion banner, its final message) | `qa_signoff.issues_found` is the single source. `qa/report.py` renders `qa_report.md` (`render_qa_report`) and `QA_FIX_REQUEST.md` (`render_fix_request`) from it; the reviewer ends with one `Verdict:` line |
| `QA_FIX_REQUEST.md` from an earlier pass could survive and send the fixer after old issues | rewritten on every pass that has issues; kept only when there are none (human feedback) |
| QA fixer received `qa_fixer.md` raw, with `{{SPEC_DIR}}` and `{{MIN_COVERAGE}}` unfilled | built by `prompts_pkg.get_qa_fixer_prompt`, which also adds the verify section |
| Planner wrote `verification_strategy`, `qa_acceptance`, `parallel_groups`, `startup_command` into the plan, and a multi-section `build-progress.txt` | none of these is read by code: no longer requested. `implementation_plan/progress_file.py` writes a short `build-progress.txt` header from the plan; sessions append one line per blocker |
| `init.sh` from a 70-line template on every plan | only when missing, one line per service |
| `spec.md` "comprehensive (500+ chars)", six QA tables | same required sections, bullets, one checks list tied to `FR-###` |
| Completion banners in planner, critic, follow-up planner, fixer | one line |
| Insight extractor without size limits | three entries per list, 25 words per string — what `memory_manager` reads back |

`core/llm_optimization.ARTIFACT_RULES` holds the general rules in the shared
system prompt, a cached prefix every provider and phase receives once.
`tests/test_artifact_rules.py` pins the reductions.

QA reviewer and fixer usage now reaches `core/usage_tracker`
(`agents/session.record_client_usage`); before, only the replay recorder saw it,
so the savings were not even measurable.

## Context: measure, then compact or clear

`context_mgmt/` gives every session of a task a **guard**. Per-task policy, in
`task_metadata.json`:

```json
"contextPolicy": {"mode": "auto", "thresholdPct": 50, "prepareHandoff": true}
```

`mode` is `auto` (default), `compact`, `clear` or `off`; the threshold is
clamped to 30–90 % in steps of 5. The file is re-read on change, so editing it
from the task panel applies to the running build.

### The two actions

* **compact** keeps the thread and replaces its history by a summary plus the
  last turns. Right when the work in progress still needs its working memory.
* **clear** opens a fresh thread seeded with a handoff note. Right when what
  came before is finished — a new subtask, a new QA pass — and the cheapest
  from then on.

`auto` decides (`context_mgmt/decide.py`, a pure table-tested function): clear
at a task boundary, after two compactions of the same subtask, when the history
is mostly tool output, or on "prompt too long"; compact otherwise.

### Per provider

The matrix `capabilities/providers.yaml` gained a `context` block, served by
`/providers/agentic-capabilities` (`contextCompact`, `contextUsage`) so the UI
does not mirror it:

| | compact | usage measured from |
|---|---|---|
| Claude (and the providers that degrade to it) | native: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set to the threshold in `create_client`'s `sdk_env`; the CLI compacts mid-turn and emits `compact_boundary` | `AssistantMessage.usage` per turn (input + cache) |
| Codex CLI | native: `-c model_auto_compact_token_limit=<threshold × window>` | `turn.completed.usage.input_tokens` |
| OpenAI API, Gemini, DeepSeek, xAI, Mistral, Copilot, Windsurf, Ollama/LM Studio, OpenCode, Antigravity | emulated: the conversation log is rewritten (`conversation_log.replace_with_summary`) and replayed | the last turn's `prompt_tokens` / `prompt_eval_count` where reported, else characters ÷ 4 |

Clear works the same everywhere. Clients expose the fill through three
duck-typed attributes: `last_context_tokens`, `context_window_tokens`,
`context_usage_source`. The window comes from the client (Ollama's `num_ctx`),
then models.dev's `limit.context` (cache only, `public_model_registry`), then
the prefix table in `context_mgmt/windows.py`, which a test keeps in step with
the frontend gauge's table.

### When it acts

1. **Before the replay** (`ContextGuard.pre_session`): the cheapest moment,
   nothing has been sent. A replay already past the threshold is cleared or
   compacted first. Since every coder session replays the model's log, this is
   where most input tokens are saved.
2. **During the session** (`observe`): past the threshold the **handoff is
   prepared in the background**, by the task's own provider (`create_agent_client`
   with the tool-less `spec_compaction` type, so an Ollama task never needs a
   Claude token), while the agent keeps working. The session stops at the next
   **safe point**, with no tool call in flight, once the handoff is ready, or at
   once past the hard threshold (`min(threshold + 30, 85)`) with the
   deterministic handoff (plan state, `git status`, recent commits, last errors,
   last message). Native compaction is left to the provider below the hard
   threshold.
3. **On "prompt too long"** (`context_mgmt/recovery.py`): one clear per subtask
   instead of halting the build; a second failure halts as before.

The session returns `"context_reset"` and the coder or planner loop re-runs
without advancing the subtask, exactly like a hot swap. Only callers that pass
`run_agent_session(..., context_managed=True)` get that status; the other users
of `run_agent_session` are untouched. QA passes always start fresh (nothing is
replayed), so their guard only measures.

A clear archives every live log as `.cleared.` (retired, never replayed or
inherited), forgets the Claude resume pointer (`.session.json`,
`AUTO_CLAUDE_RESUME_SESSION_ID`) and leaves `context/handoff_pending.md`, which
the next session reads once as fenced data after the injection guard.

### Manual control and the UI

`CONTEXT_ACTION.json` (`{action, phase, subtaskId, requestedAt}`) is a one-shot
request written by the frontend into every copy of the spec dir, like
`HOT_SWAP.json`; the running session consumes it at its next safe point.

The guard emits `CONTEXT_USAGE` (throttled to 2 points or 10 s) and
`CONTEXT_ACTION_APPLIED` task events. `agent-events-handlers.ts` sends them
straight to the renderer, before XState. The renderer shows:

* a gauge in the task detail header (ring, threshold tick, handoff state,
  tokens / window, and a popover to change mode and threshold live and to
  trigger *Compact now* or *New thread*, with the recommended one highlighted);
* a mini gauge on the Kanban card while the task runs;
* a toast for every applied action;
* the policy fields at task creation and in the edit dialog.

The listener lives in `stores/global-listeners.ts`, like every other.
