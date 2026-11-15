---
feature: Leçons appliquées à une tâche
summary: >-
  Chaque prompt qui reçoit les leçons de la boucle d'apprentissage avec la spec de sa tâche les
  inscrit dans applied_lessons.json ; le panneau dit « N leçons appliquées » et une leçon se
  désactive pour cette tâche seule. Les points de contrôle d'un type de tâche n'arrivent dans sa
  spec que si l'historique QA du dépôt le demande. Aucun agent ne peut écrire le fichier.
---

# Lessons applied to a task (#345)

The Learning Loop already reached every phase of a build (spec writer and its
critic, planner, coder, QA reviewer and fixer): the rules a person adopted
from reviews ([review-lessons.md](review-lessons.md)) and the patterns mined
from builds. What a person could not see was *which* of them a given task
received, and a rule that did not fit one task could only be removed for every
task. #345 adds both, and the "checkpoints by task kind" the issue asked for,
on today's code.

## What a prompt records

`learning_loop.prompt_injection.get_learning_context(project_dir, phase, …,
spec_dir=…, agent=…, kind=…)` is still the one entry point
(`context_for_agent` for agents keyed by type). With a `spec_dir`:

1. it reads the ids the person turned off for this task
   (`learning_loop.applied.disabled_ids`);
2. it picks the rules (`review_lessons.rules_for_prompt`) and the patterns
   (`PatternApplicator.select`), both leaving those ids out *before* their
   count and size limits, so a turned-off lesson frees its place;
3. with a `kind`, it adds the kind's checkpoints (below);
4. it renders the blocks exactly as before (`render_rules`,
   `PatternApplicator.render`, `kind_checkpoints.render`) and records what it
   carried in `<spec>/applied_lessons.json` (`applied.record`): id, kind
   (`rule`, `pattern`, `checkpoint`), text, the agent it went to, pattern type
   and confidence, time. A lesson given again moves to the end; 60 rows at most.

The callers pass the `spec_dir` they already had: `prompts_pkg/prompt_generator.py`
(planner and coder), `qa/reviewer.py`, `qa/fixer.py`, and
`spec/phases/spec_phases.learning_context_for` (spec writer, quick spec, critic).
Without a `spec_dir` (ideation, PR review), nothing is recorded and nothing
changes.

The record is a convenience for the panel, never a condition of the build: a
missing, foreign, unreadable or symlinked file reads as empty, and a write that
fails is dropped (atomic `mkstemp` + `os.replace`).

## Turning a lesson off

The task panel's "Costs and context" tab shows the card
(`AppliedLessonsCard.tsx`): "N lessons applied to this task", and on demand the
list with each lesson's kind, text, agents and a "Turn off for this task"
button.

The file has two writers, each owning one field and keeping the other's as it
found it: the backend writes `lessons` in the copy of the spec directory its
prompt ran from (main copy for the spec and the plan, the worktree's for the
coder and QA); the main process writes `disabled` in **every** copy
(`main/ipc-handlers/task/applied-lessons-handlers.ts`), creating the file where
the backend has not written yet, so whichever copy the next prompt reads leaves
the lesson out. It reads every copy and merges them by lesson (one entry, every
agent it went to).

`TASK_LESSONS_SET_DISABLED(taskId, lessonId, disabled)` revalidates everything
the renderer sends: the id matches the backend's `LESSON_ID`
(`^[A-Za-z0-9_-]{1,80}$`) and must be one the task actually carried (or already
turned off), so the renderer cannot fill the file with ids of its own; a link
planted at the file name is never read and is replaced, not followed. A server
card's prompts run on the server: the card shows nothing there.

## No agent writes the file

`applied_lessons.json` is in `security.path_guard.PROTECTED_CONFIG_NAMES`: the
write hook, the shell validator (`config_write_validators`), pi's write guard
and the OS sandbox refuse it, as for `.workpilot-goal.json`. An agent that could
write it would turn the project's adopted rules off for every later prompt of
its own task (rule S2: a prompt injection in a ticket would only need one write).

## Checkpoints by task kind

A card has a kind (`tasks.classify`, recorded in `task_metadata.json` before the
spec is written). `learning_loop/kind_checkpoints.py` holds a few checkpoints per
kind (`bug_fix`, `hotfix`, `feature`, `refactoring`, `upgrade`, `test`): reproduce
a bug in a failing test before fixing it, name the behaviour a refactoring must
not change, list the breaking changes an upgrade touches…

They are not written into every spec: that would be noise the model learns to
skip. They go to the spec writer and its critic only when **this repository's**
history says specs of this kind come back from QA. The history is read from the
project's spec directories (`task_metadata.json` for the kind,
`implementation_plan.json` for `qa_iteration_history` and `qa_stats`), the same
files every build writes for every stack and provider, newest 200, the current
task left out. The rule: at least 3 finished tasks of the kind, and on average
1.5 QA passes or more, or 40 % rejected at their first pass. The block says so
with the numbers and the most frequent issue types, so the model knows why it is
there. No model is involved.

Only the spec phases pass a `kind`: the planner, coder and QA get the spec that
already covers the checkpoints. Each checkpoint is a lesson like any other
(`checkpoint-<kind>-<n>`), recorded and turned off the same way.

## Tests

`tests/test_applied_lessons.py` (record, merge, disable per task, thresholds
table, spec block, agent-write refusals),
`main/ipc-handlers/task/__tests__/applied-lessons-handlers.test.ts` (merge,
every copy, hostile arguments, links, server cards),
`renderer/components/task-detail/AppliedLessonsCard.test.tsx`.
