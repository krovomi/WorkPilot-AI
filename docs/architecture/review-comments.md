# Review comments anchored on a line

> Rationale for the line comments of the review. The normative summary is the
> row in [`docs/CLAUDE.md`](../CLAUDE.md); where the two disagree,
> `docs/CLAUDE.md` wins.

## Why

Rejecting a task used to mean free text: "in `OrderService.cs`, method X does
not handle a null order". The fixer has to find the place again, and is
sometimes wrong. A comment on the line is unambiguous, shows when it has been
dealt with, and is the next review's checklist. It is the gesture every
developer knows from a pull request; WorkPilot had it only once the PR was
open (`pr_followup`).

## The gesture

In the guided review ([guided-review.md](guided-review.md)), each line of the
diff has a comment button in its gutter, reachable by keyboard. The comment
is shown on the file, in the group it was written in, with its status. The
open comments are listed in **Request changes**, and leave with the request,
alone or with the free text and images.

| Status | Who sets it |
|---|---|
| `open` | the person, when writing it or reopening it |
| `addressed` | **the orchestrator**, when the QA fixer's session diff touches the commented lines |
| `resolved` | **the person only** |
| `stale` | the orchestrator or the desktop app, when the commented lines are no longer in the file |

The model is never asked whether it handled a comment: what decides is the
diff of the session, `git diff <HEAD before the session>` against the
worktree, in `foundation/review_comments.py`, called by `qa/loop.py` after a
person's fix request.

## The anchor

`review-comments.json` in the spec directory holds one entry per comment:
path, side (`new` for a line of the task's version, `old` for a removed
line), line, the commit whose version of the file the line number is in (the
group's `to`, or its `from` for a removed line), an excerpt of three lines,
the text and the status.

Lines move. A comment is found again by its excerpt, the nearest match to its
old line winning; `QA_FIX_REQUEST.md` gives the line where the excerpt is
now. When the excerpt is gone, the comment is `stale`: never moved to a
guessed line. A comment on a removed line has nothing to find in the
worktree; it stays open until the person resolves it.

The file is written in every copy of the spec directory by the desktop app,
the backend updates the copy the build runs in; readers take the union by id,
the newest change winning (`shared/utils/review-comments.ts` and its Python
twin).

## Trust

- The renderer sends a task id, a relative path, a side, a line and a text.
  The main process refuses an absolute path, `..`, and a path (or a link on
  it) that leaves the worktree; it reads the excerpt and the commit from git
  itself (rule S6). Git runs with an argument list; a commit passed in must
  be a hash that exists.
- "Request changes" sends comment **ids**: the main process reads the
  comments from disk and keeps only the open ones inside the worktree.
- `review-comments.json` is in `security.path_guard.PROTECTED_CONFIG_NAMES`:
  an agent that could write it would mark its own work reviewed.
- The text is the person's: control and invisible characters are removed and
  it is capped at 4 000 characters.

## Not yet

- A server card (desktop on a server, mobile) keeps the free-text review, as
  for the guided review.
- Publishing the open comments as GitHub review comments when the PR is
  created, so that the PR follow-up takes them over (those would come back as
  external content, through `security/untrusted.py`).
- Sending a comment to a running task as a steering message aimed at the
  subtask that owns the file (F1).
