---
feature: Retours sur la revue de PR
summary: >-
  Chaque résultat d'une revue de PR s'accepte, se rejette ou se marque non applicable, avec une
  raison d'une liste fermée. Un type de remarque rejeté assez souvent est rétrogradé puis retiré,
  après la revue initiale ou de suivi, sur tous les providers ; sécurité et critique jamais. Une
  vue donne le taux d'acceptation, réinitialise une règle et écrit les conventions du projet.
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
which does not take feedback yet: the call answers `server_project`.

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

A follow-up with no new commit re-reports the previous review's findings as
they were saved; it does not re-apply feedback given since.

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

## Left for later

- Feedback on a server project (a route on the server, scoped by `project_id`).
- A self-critique pass before posting, and the maintainer's review of a
  newcomer's rejections before they count.
- A follow-up with no new commit re-applying feedback given since the review.
