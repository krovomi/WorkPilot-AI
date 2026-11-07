# Rules learned from reviews

Plan of 29 October, IA1. Two moments say how a project wants its code written
better than any analysis of past builds:

- a reviewer's thread on the task's pull request, once the PR follow-up
  ([pr-followup.md](pr-followup.md)) has fixed and pushed it;
- the feedback a person types when they reject a plan.

Each one becomes a **candidate rule**. Only a person turns a candidate into a
rule, and only rules reach a prompt.

## Where they live

`<project>/.workpilot/learning/review-lessons.json`, written by
`apps/backend/learning_loop/review_lessons.py` alone. Each entry has its
source (`pr_review`, `plan_review`), its status (`pending`, `adopted`,
`dismissed`), the candidate text, the adopted wording, where it came from (PR,
file, reviewer, or spec) and what the injection scan saw in it.

Not in the brain, where the learning loop's patterns are. A reviewer's comment
is external content (rule S2). Kept as a memory note, it could come back
through recall, the Memories tab or the context mesh before anyone read it.
In this file nothing reads a candidate but the Learning Loop screen.

A task worktree maps to its project (`project_root`): prompts are built in the
worktree, the file lives in the project.

## From a review or a plan to a candidate

- `runners/pr_followup_runner.py` records the threads of a round whose action
  is `fixed`, and only those: a round that made no commit, was reverted or
  failed to push teaches nothing. The text is the thread's first comment,
  through `clean_untrusted`. A comment rated `blocked` is not kept; one rated
  `suspect` is kept with its findings, shown on the card before any decision.
- A plan rejected with feedback (`TASK_REVIEW` on a task in `plan_review`): the
  main process posts it to `/api/brain/review-lessons/plan-feedback`
  (`main/review-lessons.ts`). It never waits for the answer, and a backend that
  is down costs the candidate, never the review.
- A candidate has a stable id (the thread, or the spec and the text). Seen
  again, it is not created twice, and a dismissed one stays dismissed.
- Past 50 pending candidates, the oldest pending ones are dropped. Decided
  entries are never dropped.

## From a candidate to a rule

The Learning Loop shows the candidates above the patterns. The person edits
the wording in place, then adopts or dismisses it, and can withdraw an adopted
rule. Routes: `/api/brain/review-lessons` (list), `/adopt`, `/dismiss`, desktop
only like the other brain routes, the project opened through `validated_dir`.
An empty wording adopts nothing; a rule is one paragraph of at most 500
characters.

## In the prompts

`learning_loop.prompt_injection.get_learning_context` puts the adopted rules
first, under "Project rules adopted from reviews", for every phase (planning,
coding, QA review, QA fix) and for every agent that `context_for_agent` maps
to one. They are not ranked by confidence like the patterns: they are the
project's word. Newest first, at most 30, at most 4,000 characters, never a
rule cut in the middle.

## What it does not do

- No LLM rewrites a comment into a rule: the person's wording is the rule.
- Nothing is adopted automatically, whatever the number of times a remark
  comes back.
- Review threads are read only from the PR follow-up, so only from GitHub for
  now.
