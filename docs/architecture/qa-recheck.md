# Re-review after a fix (QA by delta)

[`qa/recheck.py`](../../apps/backend/qa/recheck.py), wired in
[`qa/loop.py`](../../apps/backend/qa/loop.py). Finding F152.

## Why

Every QA pass was a fresh session: re-read the spec and the whole diff, start the environment,
run every suite, re-check every criterion. At effort `high` the loop allows 12 passes
([`qa/budget.py`](../../apps/backend/qa/budget.py)), so a task that needed three fixes paid for
four complete reviews, including the passes where the fixer had not fixed the issue at all.

## How

1. When a pass rejects and a fix follows (`_on_rejected`, just before the fixer), the loop
   snapshots the worktree as a git **tree object** and keeps it with the pass's issues in
   `<spec>/qa_recheck.json`. The tree is built in a temporary copy of the index
   (`GIT_INDEX_FILE`): the worktree, its index, HEAD and branches do not move; untracked files
   count, `.gitignore` is honoured (the spec directory is not in it).
2. The next pass (and only the next: the recorded pass must be `current - 1`) gets a section
   appended to its prompt, for every provider: the issues, the fixer's delta between that tree
   and a fresh one (read from git, capped at 30 000 characters), and the tests the delta's files
   map to (`foundation.touched_tests`, every language of
   [qa-tiers.md](qa-tiers.md)). A fixer that changed nothing is called out.
3. **Step 1**: the reviewer decides, from the delta, whether each issue is fixed, runs those
   tests, and looks at the delta for a new problem. Anything open rejects right there, without
   the environment, the whole suites or the criteria already verified.
4. **Step 2**, only if step 1 found nothing: the complete review of the pass's tier, every phase
   of it. **The approving pass is always complete**: an approval is never given on the delta
   alone, and the gates that follow an approval (architecture, coverage, targeted, goal) are
   unchanged.

The saving is on the passes that still reject, which are most passes of a long loop. A pass
that approves costs what it cost before, plus the short section.

Not applied: to the light tier (text only, it already reads just the change), to the first pass
of a QA run (`recheck.clear` at the start of each run and after an approval, so a rejection from
an earlier run or before human feedback never opens a pass), when git cannot snapshot the
worktree, when the rejection had no issue, or with `WORKPILOT_QA_RECHECK=0`. Any failure gives
the complete review, as before.

Repository and model text in the section (issues, diff) is data (security rule S2): fences and
`{{` placeholders are neutralised like in the scoped QA prompts.
