---
feature: Retours sur la revue de PR
summary: >-
  Chaque résultat d'une revue de PR s'accepte, se rejette ou se marque non applicable, avec une
  raison d'une liste fermée. Un type de remarque rejeté assez souvent est rétrogradé puis retiré,
  après la revue, sur tous les providers ; sécurité et critique jamais.
---

# Feedback on PR review findings (#361, lot 1)

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
| Applied to a review | `apps/backend/runners/github/services/learned_suppression.py`, called by `orchestrator.review_pr` |

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

## Left for later

- Follow-up reviews (`followup_review_pr`) do not apply the suppressions yet:
  their verdict comes from the model and would have to be recomputed.
- Feedback on a server project (a route on the server, scoped by `project_id`).
- The generated `.workpilot/review-conventions.md`, a self-critique pass before
  posting, the maintainer's review of a newcomer's rejections, a reset or
  per-period dataset, and the acceptance-rate metrics in a
  view.
