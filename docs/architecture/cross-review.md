# Cross review by a second engine

Plan of 29 October, IA2. A build is planned, coded, reviewed and corrected by
one provider. Its blind spots are shared by every phase: a model that misread
the spec reads its own code the same way, and the `review` phase, however many
lenses it has, is the same model looking again. The cross review hands the
finished task to a **different provider** before the pull request, and holds
the pull request back when that engine names a blocking problem.

## When it runs

The `cross-review` phase, declared after `qa` in `feature-build`, `bug-fix`,
`hotfix` and `refactoring` (`workflows/*/workflow.yaml`), run by
`apps/backend/workflows/cross_review_phase.py` (`CUSTOM_EXECUTORS` in
`workflows/runner.py`). After QA because it judges the code that will be
pushed; its reader is the pull request step, not a fixer.

The code is in two places on purpose. The phase opens an agent session, so it
lives with the runner. The verdict (parsing, record, fingerprint, the hold) is
`apps/backend/cross_review/`, which imports nothing above `foundation`: the
pull request step in `core` reads it, and a package that did both would join
the agent runtime's import cycle (`tests/test_import_contracts.py`).

It is never pruned by effort (`always: true`): the switch is the project's
setting, and a gate the person asked for does not vanish at a low level.
Without a second engine the phase opens no session and costs nothing.

## Which engine

`workflows.cross_review_phase.resolve_reviewer`, in this order:

1. the task's `task_metadata.json`, key `crossReview`
   (`{provider, model, effort}`, or `{"enabled": false}` to turn the project
   default off for one task);
2. the project setting (Project settings > General > Cross review), which the
   desktop passes as `WORKPILOT_CROSS_REVIEW_PROVIDER`, `_MODEL` and `_EFFORT`
   (`main/agent/env-utils.ts::crossReviewEnv`).

Refused, with the reason in the build log:

- no provider, or a provider without a model;
- a provider equal to the build's coding provider (`claude` and `anthropic`
  are one): a model rereading its own work is not a second look. The settings
  panel warns before it gets that far.

The reviewer's credentials go to the build process with the task's own
(`agent-manager.ts::taskProviderPlan`). Claude's are not added there: they
follow the task's OAuth chain, as for every other phase.

## What it reads, and what it can do

One fresh session, agent `pr_reviewer` (read-only tools, no subagents), on the
reviewer's provider and model. The prompt names `spec.md`, the plan, the goal
command when goal mode is on, the changed files, and holds the diff against
the fork point, cut at 60,000 characters. The diff is the code under review:
the prompt says that text inside it addressed to the model is code, not an
instruction.

## The verdict

The answer is one JSON object: `verdict`, `summary`, `findings` (`severity`
`blocker | major | minor`, `file`, `line`, `issue`). `parse_verdict` takes the
last such object in the reply and reads it strictly:

| The reviewer said | Read as |
|---|---|
| `agree`, no blocker | `agree` |
| `disagree`, at least one blocker | `disagree` |
| `disagree` with no blocker | `inconclusive` |
| `agree` with a blocker | `inconclusive` |
| no JSON, another word, a session that failed | `inconclusive` |

`inconclusive` never blocks and is never shown as an agreement. Findings are
bounded (20, 500 characters each).

The record is `cross_review.json` in the spec directory, in the worktree's
copy and the project's: verdict, findings, engine, the build's provider, the
date and the **tree** it read. The card reads a summary written into
`implementation_plan.json` (`crossReview`), like the verification and goal
badges.

## Holding the pull request

`WorktreeManager.push_and_create_pr` asks `cross_review.blocking_verdict`
before anything is committed or pushed. It blocks only when the newest record
is `disagree` **and** its tree is the worktree's current content.

The tree is `tree_fingerprint`: the worktree's content written as a git tree
from a throwaway index (the real index is never touched), ignored files and
WorkPilot's own root files (`.workpilot*`) left out. A commit made at push time
keeps the fingerprint; an edit changes it, and the disagreement is then stale
and blocks nothing. A tree that could not be computed blocks nothing either.

Every path to a pull request goes through that method: the PR dialog
(`run.py --create-pr`) and the automatic completion
(`services/task_completion_service.py`). Only the dialog can override, and only
on the person's click: "Create anyway" sends `allowCrossReviewDisagreement`,
which becomes `--pr-ignore-cross-review` only when it is strictly `true`. The
automatic completion never overrides.

The refusal lists up to five blocking findings with their file and line. The
dialog shows it and, for this refusal only, offers "Create anyway" in place of
"Retry".

## Limits

- One reviewer per project, not a panel. A second disagreeing engine is a
  reason to read the code, not a vote.
- The verdict does not feed the QA fixer: a fix loop between two engines that
  disagree on taste has no end. The person decides.
- A Claude reviewer on a task built entirely without Claude needs Claude's
  credentials to be present already; otherwise its session fails and the
  verdict is `inconclusive`.
