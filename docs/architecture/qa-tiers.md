# QA tiers: light, targeted, full

Every QA reviewer pass first reads the task's change set from git
([`foundation/change_scope.py`](../../apps/backend/foundation/change_scope.py)): committed,
uncommitted and untracked files since the base branch, with their changed lines. The answer
picks one of three tiers, from git and file names only, so the same change gets the same tier
on every provider and model. The loop logs it before the session (`QA scope: light | targeted
— QA ciblée | full (reason)`), and the rendered `qa_report.md` carries a `Scope:` line.

| Tier | When | The reviewer | Subagents | Coverage gate |
|---|---|---|---|---|
| **light** (QA légère, F133) | only text/documentation files (≤ 10 files, ≤ 400 lines), or no change at all | spec + diff inline, checks the change against the spec; no test, no environment, no scan | none | not applicable |
| **targeted** (QA ciblée, K2) | ≤ 3 code files and ≤ 150 changed lines in them (text files aside), each with a mapped test | spec + diff + the exact test files inline; runs only those, with coverage of the touched files; security check on the changed files | none | `qa/targeted_gate.py` |
| **full** | anything else, and every doubt | `qa_reviewer.md`: environment, every suite with coverage, browser, database, scans of the changed files | the roster | `qa/coverage_gate.py` (unit + integration) |

The tier is read again on every pass: a fixer that grows a targeted change past a threshold,
or touches a security file, turns the next pass into a full one.

## Why a targeted tier

A one-line fix in a Python module with its test paid for the whole QA: dev environment, every
suite with coverage, subagents, project memory. The coverage gate asked for unit **and**
integration coverage of the repository, so the reviewer had to run everything to produce two
numbers that measure the repository, not the change. Small code changes are the bulk of the
board's cards; the light tier (text only) did not reach them.

## Selection

`classify()` keeps the full review for any doubt. A change is targeted only when all hold:

- `WORKPILOT_QA_LIGHT` and `WORKPILOT_QA_TARGETED` are not `0`;
- at most `TARGETED_MAX_CODE_FILES` (3) code files, at most `TARGETED_MAX_CHANGED_LINES` (150)
  lines changed in them, measured with `git diff --numstat` like the light tier (an untracked
  file counts all its lines);
- every code file is Python or TypeScript/JavaScript (`.py`, `.ts`, `.tsx`, `.js`, `.jsx`,
  `.mts`, `.cts`, `.mjs`, `.cjs`): any other type a program reads (`.cs`, JSON, YAML, TOML,
  lockfiles, `package.json`, `requirements*.txt`) is full;
- no code file is security-sensitive (a `security/` directory, `server/auth*`), CI
  (`.github/`, `.gitlab/`, `.circleci/`), generated (`dist/`, `build/`, `vendor/`,
  `node_modules/`, `generated/`, `.agents/`, `*.d.ts`, `*.min.js`, `*_pb2.py`, `*.generated.*`,
  or a header saying `@generated`, `DO NOT EDIT`, `auto-generated`), project-wide configuration
  (`conftest.py`, `setup.py`, `*.config.*`, dot-files) or deleted/renamed (a deleted test
  included);
- no touched file nor mapped test has a character a shell would interpret (space, `;`, `$`,
  quotes): the prompt hands those paths to the reviewer as command arguments, and a file name
  from the target repository is data (security rule S2);
- every code file has at least one test by convention. One without is full: the tier never
  skips testing a file.

`requirements*.txt` and `constraints*.txt` stopped being "text only" with this change: pip
reads them, so they never get the light review either.

## Test mapping

[`foundation/touched_tests.py`](../../apps/backend/foundation/touched_tests.py) looks the tests
up in the repository's file list (`git ls-files` plus untracked files), never by running
anything:

- Python: `test_<stem>.py` or `<stem>_test.py` next to the source, or under a `tests/` or
  `test/` directory at the source's level or above (at any depth below it:
  `tests/unit/core/test_engine.py` maps `src/core/engine.py`). `conftest.py` is not a test.
- TypeScript/JavaScript: `<stem>.test.<ext>` or `<stem>.spec.<ext>` next to the source, or
  under `__tests__/`, `tests/` or `test/` at the source's level or above; inside `__tests__/`,
  `<stem>.<ext>` counts too.
- A changed test maps to itself.

A name shared by several modules can map to more than one test: more tests run, never fewer.

## What the targeted pass must show

The prompt ([`prompts/qa_reviewer_targeted.md`](../../apps/backend/prompts/qa_reviewer_targeted.md))
inlines the spec, the diff and the map `source → tests`, and asks the reviewer to run each test
file by path with the project's runner and coverage of the touched files. Its approval stands
only if [`qa/targeted_gate.py`](../../apps/backend/qa/targeted_gate.py) finds, deterministically:

1. each mapped test in `qa_signoff.targeted_tests` with `passed: true`;
2. each mapped test named in a shell command the reviewer ran in this session.
   `qa/reviewer.py` collects the `command` (or `cmd`) of every tool call on both stream paths
   (Claude SDK and `AgentClient`), so the evidence does not depend on the provider;
3. `qa_signoff.coverage.touched_files` (and every `per_file` value of a touched file) at least
   `WORKPILOT_QA_MIN_COVERAGE`; `measured: false` or no value rejects. With the threshold at
   `0`, the tests are still required.

Otherwise the sign-off is set to `rejected`, `QA_FIX_REQUEST.md` lists the gaps and the fixer
runs, within the task's QA budget. An error inside the gate rejects too, unlike the coverage
gate's: the tier never approves a task whose tests it did not see run.

**Coverage is that of the touched files, not of the diff lines.** Diff coverage needs a tool
(diff-cover and the like) that most target projects do not have, while every coverage runner
reports per file (`pytest --cov`, `vitest --coverage.include`, `jest --collectCoverageFrom`).
At the default threshold (100 %) a touched file fully covered implies covered changed lines;
below it, the changed lines may be among the uncovered ones, which the report does not tell.

## Limits

- The evidence is the commands the reviewer ran and what it recorded, not a run by the loop
  itself: the target project's runner, environment and working directory are only known to
  the session. The command check stops a sign-off that claims tests no command named.
- Languages other than Python and TypeScript/JavaScript always get the full review.
