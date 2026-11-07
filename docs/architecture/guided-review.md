# Guided review: the diff grouped by intention

> Rationale for the guided review. The normative summary is the row in
> [`docs/CLAUDE.md`](../CLAUDE.md); where the two disagree, `docs/CLAUDE.md` wins.

## Why

Reviewing has become the bottleneck, not generating. A flat, alphabetical
diff makes the reviewer rebuild the intentions behind each change. Tools that
group a diff by intention have to guess the intentions with a model;
WorkPilot already has them written down: the plan. Each subtask has a title
and a description from the planner, and the build records the commit each
subtask ended on.

## What is shown

The review's **Guided review** button (next to **View**) opens the groups, in
this order:

1. **One group per subtask, in plan order.** It shows the diff of the
   subtask's own commit range, `commit_before..commit_after`, not the final
   diff filtered by path: what the subtask actually did. The planner's
   description is the explanation; no model is called.
2. **The commits no subtask recorded**, one group each: a QA fixer commit, a
   commit made by hand, a sync with the base branch.
3. **What is not committed yet** (staged, unstaged and untracked files).

On each file:

- **Outside the plan**: no subtask announced it in `files_to_modify`,
  `files_to_create` (or `files_changed`). Not a fault, but where a reviewer
  looks first. It is the code-side counterpart of `SpecTraceabilityCard`.
- **Changed again later**: a later group rewrites the file; the final diff is
  one click away.
- **Moved code**: a block removed in one file and added unchanged (lines
  trimmed, blank lines dropped) in another is paired, with git's own
  threshold (3 lines and 20 alphanumeric characters). `git diff
  --color-moved` only exposes the move as ANSI colours, too fragile to parse,
  so the pairing is a pure function. A block changed while it moved, or
  re-indented in place, is an edit, not a move.
- **QA issues** of the latest QA iteration (`qa_iteration_history`, which
  carry `file` and `line`) appear on the last group that changed the file.
  An issue about a file the task did not change is listed apart.
- **Viewed**: kept per task and file in the renderer's storage, keyed on the
  patch's hash, so a file whose patch changed after a QA fix is to be read
  again and the rest stays viewed.

## How

| Piece | Where |
|---|---|
| The range each subtask owns | `RecoveryManager.record_good_commit(hash, subtask_id, commit_before)` in `memory/build_commits.json`, called by `agents/session.py` |
| Every decision (ranges, groups, out of plan, moves, QA anchoring, viewed) | `shared/utils/review-groups.ts`, pure, tested without git |
| Reading the plan, the records and git | `main/ipc-handlers/task/review-groups-handlers.ts` (`TASK_REVIEW_GROUPS`) |
| The view | `task-review/GuidedReviewDialog.tsx` |

`planRanges` gives each record `commit_before..hash`. A record written by an
older build has no `commit_before`: its range starts at the previous record
(or the merge-base), which can absorb a commit made between two sessions, so
the view says the grouping is approximate. Consecutive commits of one
subtask form one range; a subtask recorded in separate ranges shows its parts.

## Trust

- The renderer passes a task id and nothing else; the worktree, the spec
  directory and every ref are resolved in the main process (rules S4, S6).
- Git runs with an argument list, never a shell; the commit hashes passed to
  `git diff` come from `git log` and `git merge-base`, checked as hex.
- WorkPilot's own files and build outputs are left out, as in the flat diff.
- A git failure is an error, never an empty review.

## Not yet

A server card (desktop on a server, mobile) keeps the flat diff: the grouping
runs where the worktree is, and serving it needs a route with a permission
and a `project_id` (rule S5). Comments anchored on a line of this view and
sent back to the agent are F9.
