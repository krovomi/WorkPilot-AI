# Pause, resume, and how a phase reports failure

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Pause, resume, and how a phase reports failure

A build is a stack — `handle_build_command` → the coder loop → a session → a
phase — and two things can happen deep inside it that the current frame has no
business resolving: the user pressed Pause, or a phase established it cannot
produce its output. Both used to be a bare `return`, which unwinds exactly one
frame. The caller could not tell "finished" from "gave up", so a build whose
planning had failed went on to run QA, the hard gates and `finalize_workspace`
over a worktree with no implementation plan in it.

`core/build_signals.py` holds the two exceptions that unwind to the entry point:
`BuildPaused` (not a failure — nothing is finalized, the card keeps its column)
and `BuildHalted` (which carries the sentence the user will read).

The planner remains the active phase until its plan passes validation. Starting
its session is not a transition: a timeout, quota wait, authentication recovery
or hot model switch must reopen planning, for every provider. The coder loop
may return normally only with a nonempty, completed plan and no session error;
an empty plan, exhausted budget or unfinished subtasks halt before QA. The loop
detector propagates `BuildPaused` too, rather than returning as if coding finished.

**The pause has one store.** `core/pause_state.py` owns `pause_state.json`,
which lives in the spec directory. That is the whole point: the flag used to
live inside `implementation_plan.json`, a file that does not exist during spec
creation or planning, so pressing Pause on a task that was visibly running
answered "Implementation plan not found". The spec directory exists from the
moment the task does.

| Reader | Checkpoint |
|---|---|
| `agents/coder.py` | top of the session loop — the same place for a planning iteration and a coding one |
| `qa/loop.py` | between review passes, so a pause does not wait out a long one |
| `spec/pipeline/orchestrator.py` | between spec phases |

The Electron side writes it through one helper too
(`ipc-handlers/task/pause-state-utils.ts`): four call sites used to clear
`plan.paused` by hand, and one missed copy means the restarted backend re-pauses
at its first checkpoint and the resume looks like it did nothing. The legacy
in-plan block is still *read* so a task paused before this change does not
silently un-pause on upgrade; nothing writes it any more.

**Resuming re-reads the disk rather than being told a phase.** `TASK_RESUME`
clears the flag and restarts `run.py`; phase entry is state-driven
(`is_first_run`, `get_next_subtask`, `should_run_qa`), so no plan means planning
runs again, an incomplete plan resumes at the first unfinished subtask, and a
complete one goes to QA — which itself continues from its persisted iteration
count. Naming a phase in the resume would be a second opinion about a question
the spec directory already answers, and the two would drift. The same property
is what makes switching provider mid-task cheap: `TASK_RESUME_WITH_PROVIDER`
rewrites the task's engine from the paused phase on (see *Le moteur d'une
tâche*), lifts the pause and relaunches through `resumePausedTask`, and touches
nothing else — completed subtasks, the spec and the QA sign-off stay as they are. Only an
explicit "re-run this phase" discards work, and only downstream of the phase
asked for (`plan-rerun-utils.ts`).

**Resuming continues the phase; it does not pay for it twice.** State-driven
entry answers *which* phase re-opens, and nothing more: the phase itself
re-opened with an empty head, re-read the same files and re-derived the same
analysis the interrupted session had already done. Two channels carry it
across now, one per half of the product. `TASK_RESUME` hands the subprocess the
session id in `<spec_dir>/.session.json`, so the Claude SDK rehydrates that
transcript (single-shot — `create_client` pops the variable, so only the first
session of the resumed run replays it). For every other provider it is
`conversation.<provider>-<model>.jsonl`, which `_maybe_replay_conversation`
already replayed on every session start.

The two channels are never both open. `.session.json` is written from the
session's **first** message (the SDK's init message), not only from its last —
written at the end, a session killed halfway left the pointer on the session
*before* it, often another phase's, and the resume rehydrated the wrong
transcript. It records its `provider`, and the frontend hands back a Claude id
only (a Codex thread id in the Claude SDK fails the session). `create_client`
drops a resume whose transcript is not under `<CLAUDE_CONFIG_DIR>/projects/`
(another profile, another machine) rather than fail on it, and a
`ClaudeAgentClient` that *is* rehydrating natively skips the log replay
(`resumes_native_session`) — the SDK already holds those turns.

**Closing the application is a pause, opening it is the resume.** Quitting used
to kill every agent and leave the card `in_progress` with nothing behind it; a
minute later it read "stuck", and the stuck recovery reset the subtask in
progress to `pending`, deleted what it had recorded and restarted without the
session — the phase from the top, on every provider. `before-quit` now calls
`pauseRunningTasksForShutdown` (`ipc-handlers/task/interrupted-runs.ts`) before
`killAll`: the Pause button's own `pause_state.json`, in every spec directory
copy, with `reason: "app_shutdown"`. At launch, once the profile manager is up
and the window has loaded, `resumeTasksInterruptedByAppExit` resumes those — and
the tasks persisted `in_progress`/`ai_review` with no process behind them, which
is what a crash, a forced kill or an OS shutdown that never delivered
`before-quit` leaves. A pause the **user** asked for has no reason and stays a
pause. Both go through `resumePausedTask` (`resume-task.ts`), the Reprendre
button's path, which sends a task with no `spec.md` back to the spec pipeline
(it skips every artefact it already wrote) — `run.py` refuses that directory.

**The interrupted subtask is continued, not skipped.** `get_next_subtask` picks
`pending` work only, so a subtask the dead process had marked `in_progress` was
passed over — or, when it was the last, the build reported "no pending
subtasks" and halted with the work unfinished. The coder loop is sequential, so
when a build process starts nothing else is running: `reopen_interrupted_subtasks`
(`core/progress.py`) puts every `in_progress` subtask back to `pending`,
keeping what it recorded, and marks it `interrupted_at`. The next session's
prompt then carries `interrupted_subtask_directive` — look at `git diff`, the
work already on disk is not to be redone — on top of the replayed transcript.

**A model that is new to a phase inherits it.** The conversation log is
per-(provider, model) on purpose — switch away and back, and a model resumes
its own context. On the switch itself that property is exactly wrong: the model
the user just chose has no log, nothing is replayed, and the phase restarts from
the prompt, which is the opposite of what the Pause button promised.
`read_log_for_phase_resume` gives a model with no log of its own the **same
phase's** tail (`MAX_CARRYOVER_MESSAGES`) from whichever model last wrote one,
and writes it into the new model's log — a takeover, not an alias, so from the
next session on that model reads its own file like every other.

The phase is the whole guard, and it is not a detail: a per-phase model
configuration legitimately runs coding on a model the planner never used.
Inheriting by recency alone would replay the planner's entire reasoning into
every such coding session, on every build that names two models. An archived log
(`.too-long.`, `.trimmed.`, `.archived.`) is never inherited either — a
prompt-too-long halt archives precisely so the next run does not replay it, and
reading it back through the carry-over would fail the run the same way.

**A relaunch is owed an event.** `TASK_START` tells the machine it is starting
(`determineStartEvent`); resuming told it nothing, and a machine left settled in
`human_review`/`error` keeps the review reason and the failure message that go
with it — so the red "this task failed" banner stayed at the top of a task that
was visibly running again, quoting the run it had replaced. `relaunchEventFor`
is the one answer to what the two resume paths owe it, and the sequence counter
is reset in the same breath: a restarted backend numbers its events from zero,
and `isNewSequence` drops anything below the last number it saw, so without it
the resumed run's phases reached nobody at all.

**Pause and Reprendre belong to the run, not to the column.** A paused task
keeps the status it was paused in — often `human_review`, once a phase reported
a failure — and the task panel's action bar was keyed on status, so the one
screen that owns the provider/model/effort switch was the one screen that could
not simply resume. `TaskRunControls` is now answered from the pause flag first,
before any status branch, which is how the kanban card had always decided it.

**And the model it resumes with is picked, never typed.** The panel's
"Autre (catalogue officiel)" row is a door, not a model: it opens
`OfficialModelSearch` over the provider's own library, which is the same thing
the per-phase selector does and for the same reason. A free-text field accepts
`gemma4:12b-it-q4_K_M` whether or not anything published it, and the only
symptom is the resume failing on `pull model manifest: file does not exist` —
after the restart, under a name the user has no way to check.

**A phase that gives up says so.** `PLANNING_FAILED` and `CODING_FAILED` were in
the XState machine from the start and emitted by nobody: every real failure
reached the frontend as a process exit, and the machine's `setError` did not
handle that event. The result was a card in Human Review with a red *Has Errors*
badge and no reason anywhere in the UI — the toast even announced it as "Ready
for Review", because the status is the same one a finished build gets.

Now each halt emits the event with its message (`_emit_phase_failure` in
`coder.py`, `_emit_planning_failed` in the spec orchestrator, `_emit_fatal_error`
for an unhandled crash, `_emit_startup_failure` for a prerequisite the build
could not satisfy — that last one because `validate_environment` ends in
`sys.exit(1)`, and SystemExit is not an `Exception`, so the crash emitter never
saw it and a cause known in full went to the card as "exited unexpectedly with
code 1"), `setError` covers every event that can reach the `error`
state — including `PROCESS_EXITED`, whose message names the exit code because
that is still better than nothing — and the message is persisted beside the
status it explains (`plan.errorMessage`) so it survives a reload.
`TaskFailureBanner` renders it at the top of the task panel, and the toast reads
`reviewReason` rather than the column before choosing its wording.
