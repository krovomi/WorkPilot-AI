---
feature: Retours sur la revue de PR
summary: >-
  Chaque résultat d'une revue de PR s'accepte, se rejette ou se marque non applicable. Un type de
  remarque souvent rejeté est rétrogradé puis retiré, sur tous les providers ; sécurité et
  critique jamais. Taux d'acceptation, réinitialisation, conventions ; sur un serveur, le rejet
  d'un membre attend un propriétaire ; une remarque répétée au même endroit est fondue.
---

# Feedback on PR review findings (#361)

The AI PR review (`runners/github/`) raised the same remarks on every pull
request, including the ones the team had already decided to ignore: review
fatigue. Each finding now takes a verdict, and the reviewer learns from the
verdicts of its project.

## The verdict

In the PR view, each finding of the saved review has three buttons: **Accept**,
**Reject**, **Not applicable**. Rejecting or marking not applicable opens an
optional reason, from a closed list (`too_pedantic`, `project_convention`,
`false_positive`, `legacy_exception`, `other`), and an optional sentence
(at most 280 characters). The last verdict on a finding is the one that counts.

| Piece | Where |
|---|---|
| Buttons, reason, note | `renderer/components/github-prs/components/FindingFeedback.tsx`, state in `hooks/useFindingFeedback.ts` |
| IPC | `GITHUB_PR_REVIEW_FEEDBACK_SET` / `_GET` (`shared/constants/ipc.ts`), types in `shared/types/review-feedback.ts` |
| Handler | `main/ipc-handlers/github/review-feedback-handlers.ts` |
| Store, the only writer | `main/ipc-handlers/github/review-feedback-store.ts` |
| Learning, the only reader | `apps/backend/learning_loop/review_feedback.py` |
| Applied to a review | `apps/backend/runners/github/services/learned_suppression.py`, called by `orchestrator.review_pr` and `orchestrator.followup_review_pr` |
| Project-wide view (lot 2) | `renderer/components/github-prs/components/ReviewFeedbackStats.tsx`, state in `hooks/useReviewFeedbackStats.ts` |
| Its IPC | `GITHUB_PR_REVIEW_FEEDBACK_STATS` / `_RESET`, `GITHUB_PR_REVIEW_CONVENTIONS_WRITE`; handler `main/ipc-handlers/github/review-feedback-stats-handlers.ts` |
| The dataset read as the backend reads it | `main/ipc-handlers/github/review-feedback-dataset.ts`, rules in `review-feedback-stats.ts`, file in `review-conventions.ts` |
| Server projects (lot 3) | routes `apps/backend/shared_features/forge_review_feedback.py`; app side `main/ipc-handlers/github/review-feedback-server.ts`; held list `renderer/components/github-prs/components/ReviewFeedbackHeld.tsx`, channel `GITHUB_PR_REVIEW_FEEDBACK_HELD_DECIDE` |
| Self-check before posting (lot 3) | `apps/backend/runners/github/services/self_critique.py`, called by `orchestrator.review_pr` and `followup_review_pr` |

## The dataset

`<project>/.workpilot/code_review_feedback.jsonl`, one line per click:

```json
{"v": 1, "at": "…", "pr": 42, "finding_id": "f-1", "verdict": "rejected",
 "reason": "too_pedantic", "note": "", "category": "style", "severity": "low",
 "title": "Missing docstring on `foo`"}
```

The renderer is not trusted (S6). It names a project by id, a PR by number and
a finding by id; the handler checks each one (verdict and reason in their
lists, id pattern, note length) and refuses the whole call otherwise. The
finding's **category, severity and title are read from the review the runner
saved** (`.workpilot/github/pr/review_<n>.json`), never taken from the
renderer: a compromised view cannot teach the reviewer to drop a kind of
finding that was never reviewed. The file is resolved inside the project
(`resolveWritableUnder`), refused when it is a link, and past 1 MB rewritten
with its newest 2,000 lines. A server project's reviews live on the server,
which keeps their feedback (see "Server projects" below).

Why not the brain: a finding title is model output written while reading a
pull request, so it is close to external content (S2). Kept as a memory note,
it could come back through recall before anyone read it. Here it reaches a
prompt only cleaned and fenced (below), and only as a list of what to stop
saying.

## From verdicts to a learned suppression

- A finding's **signature** is its category and its normalised title: quoted
  spans and numbers become placeholders, case and punctuation go, so
  ``Missing type hint on `foo` `` and ``Missing type hint on `bar` `` are one
  remark. The description, the file and the code are never part of it.
- Per signature: rejections (reject or not applicable) minus acceptances. One
  finding is one vote, whatever the number of clicks.
- At the threshold (3 by default, `WORKPILOT_REVIEW_FEEDBACK_THRESHOLD`, bounded
  to 2–50) a matching finding is **downgraded to low** and marked « rejected N
  times on this project »; at twice the threshold it is **dropped**, and the
  review lists it under « N findings hidden by what this project rejected ».
- **Security findings and critical findings are never touched**, however often
  they were rejected: a reviewer that unlearns those is worse than a noisy one.

The step runs on the findings once the review is done, before the verdict, in
`orchestrator.review_pr`, for the multi-pass review and the parallel
orchestrator alike. It does not depend on what the model made of the prompt,
so it holds on Claude, Codex, Copilot, Ollama and every other provider. The
dataset does not record which model produced a finding: a remark rejected
under one provider is rejected under all of them.

The prompt also gets a short block (`prompt_block`) naming the rejected kinds,
so the reviewer stops spending effort on them: the multi-pass passes
(`pr_review_engine`) and each specialist of the parallel orchestrator. The
titles go through `clean_untrusted`, the list through `quote_untrusted`. The
parallel orchestrator reads the dataset in the project's own checkout, never
in the PR's worktree, whose `.workpilot/` the PR author controls.

## Follow-up reviews (lot 2)

`orchestrator.followup_review_pr` applies the same suppressions to the
follow-up's findings, for the sequential and the parallel follow-up reviewer,
before its CI fallback (`learned_suppression.apply_to_followup`). A
follow-up's verdict comes from its reviewer (the model, for the parallel one),
so it is recomputed with the initial review's rule, `_generate_verdict`,
passed in rather than copied, on the findings that remain. The new verdict
replaces the reviewer's only when the suppressed findings were what made it
severe: it must be lower than the same rule gives on the findings as
reported, and lower than the reviewer's. So a suppression never makes a
verdict more severe, a verdict the findings did not drive stands, and pending
CI still keeps a follow-up out of "ready" (`apply_ci_status_override`).
Dropped findings leave the unresolved and new id lists and the blockers; the
summary says how many were hidden or downgraded. The parallel follow-up prompt
gets the block of rejected kinds, read in the project's checkout.

A follow-up with no new commit re-reports the previous review's findings
with the feedback given since applied (lot 3): the same
`apply_to_followup`, on the CI status of the moment, keeping the suppressions
the review already listed. A finding hidden before a reset does not come back
there: a new review raises it again.

## The acceptance rate and the reset (lot 2)

Under the findings of a saved review, a folded panel, "Feedback on this
project's reviews", reads the whole dataset when opened: per category, the
findings accepted, rejected and not applicable (the latest verdict per
finding), the overall acceptance rate, and the kinds of remark the reviewer
now hides or downgrades, each with its counts, its main reason and a
**Reset** button. Nothing in it is computed in the renderer.

The main process reads the dataset as the backend does
(`review-feedback-dataset.ts`): its newest 2 MB, the same record shape, the
latest vote per finding, the same signature. The signature is computed on both
sides, so both must agree: `tests/fixtures/review_feedback/signatures.json`
holds shared cases (identifiers, numbers, accents, CJK) that the pytest and
Vitest suites both check. The threshold is the one the reviewer runs with:
`WORKPILOT_REVIEW_FEEDBACK_THRESHOLD` from the app's environment, else from
the backend's `.env` (`loadBackendEnv`), else 3.

A reset appends one line, `{"v": 1, "at": …, "kind": "reset", "signature": …}`,
through the store, still the only writer. The renderer sends a project id and
a signature; the main process refuses a signature that is not 16 hex digits
or that the dataset does not hold, before anything is written. Reading the
dataset, the backend and the app forget every vote before a reset on its
signature: the reviewer raises that kind of remark again until it is rejected
again, and the buttons of the PRs it concerned are blank again. This covers
the convention that changes in the middle of a project; nothing is deleted,
so the history stays in the file until it is compacted.

## The conventions file (lot 2)

A button writes `.workpilot/review-conventions.md`, deduced from the dataset
without a model (`review-conventions.ts`): what the reviewer drops, what it
raises as low only, the kinds of remark the project accepts at least
`threshold` times more than it rejects, and the reminder that security and
critical findings are never touched. The same dataset always gives the same
file: no date, a stable order (category, then signature), so it can be
committed and reviewed. It is written in English whatever the app's language,
for the same reason.

A finding title is model output written while reading a pull request: in the
file it is one bounded line whose Markdown and HTML characters are escaped, so
it cannot add a link, a heading or markup. The path is resolved inside the
project and refused when it is a link (`writableFileUnder`, shared with the
dataset); the content goes to a fresh temporary name created exclusively, then
renamed over the file. The reviewer does not read the file: its prompt gets
the learned block from the dataset, as before.

## Server projects (lot 3)

A server project's reviews run in its clone on the server (`forge_review`), so
the server keeps their feedback, in the clone's
`.workpilot/code_review_feedback.jsonl`, in the line shape the desktop store
writes: the review job learns from it as a local review does. The routes are
under `/api/features/forge/github/reviews` and take a `project_id`, never a
path (S5): `GET`/`POST /{number}/feedback` (a PR's verdicts; a verdict on a
finding named by id, whose category, severity and title the server reads from
the review it saved), `GET /feedback` (the dataset's newest part, the
threshold the jobs run with, the held rejections, whether the caller is a
maintainer), `POST /feedback/reset` and `POST /feedback/held`. Reading takes
`vcs.read`, writing `vcs.write` and the project's member role. The bodies are
closed shapes; the dataset, the held file and `.workpilot` are refused when a
link leads them out of the clone. In the app, the handlers check every
argument as for a local project, then send the call to the server; the stats
are computed from the server's dataset with the same code
(`computeStats`). The conventions file stays a local project's: a server's
clone is nobody's working copy.

### A newcomer's rejection waits for a maintainer

A rejection (reject or not applicable) from a member who is not a maintainer,
meaning the project's owner or an organization administrator, is **held** in
`.workpilot/code_review_feedback_held.json`, which the reviewer never reads.
The finding says "Waiting for a maintainer"; the panel lists the held
rejections, with their reason and note, and a maintainer approves each one (it
joins the dataset) or discards it. An acceptance counts at once: it only keeps
a remark. A maintainer's verdict, or an acceptance, on a held finding settles
it. Resetting a rule changes everyone's reviews, so it is a maintainer's too;
a member sees no button, and the server answers 403 anyway. The held file
names no one and keeps its newest 500 entries. A local project has one person
and holds nothing.

## Self-check before posting (lot 3)

The passes and the specialists of a review reported one remark several times:
a few lines apart, with other punctuation, once as `high` and once as `low`.
The existing deduplication dropped only exact repeats (same file, line and
title) and kept the first, so a review could repeat itself or contradict
itself on severity. Before the verdict and the learned suppressions, reports
with the same wording (case, punctuation and spacing set aside; identifiers
and numbers kept, so ``Unused import `os` `` and ``Unused import `sys` `` stay
two) on the same file, at most three lines apart, become one finding: the most
severe, then a security one, then the most confident, with the source agents
of all. The summary lists what was merged ("Self-check before posting"). It
runs without a model, on every provider, in the initial review and in the
follow-up, whose unresolved and new id lists lose the merged ids.

## Left for later

- Telling a maintainer that rejections wait, on their own channels: the
  server's "needs you" notifications (ntfy, Telegram, Teams) are built around
  a card's run; a new kind of event needs its own preferences and texts. The
  held list is in the PR view's panel meanwhile.
- Catching two remarks that ask for opposite changes: that needs a model call
  per review. The parallel reviewer's finding-validator already re-reads each
  finding against the code; the self-check stays deterministic.
- The conventions file of a server project, which would need a place people
  read and commit from.
