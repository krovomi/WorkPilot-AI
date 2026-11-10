# Git History Surgeon

Issue #360. The "Git History Surgeon" page (Git integrations). Code:

- backend: `apps/backend/git_surgeon/`, `runners/git_surgeon_runner.py`;
- main process: `apps/frontend/src/main/ipc-handlers/git-surgeon-handlers.ts` and `main/git-surgeon/input.ts`;
- renderer: `renderer/components/git-surgeon/`.

## What it answers

"This branch's history is a mess: can it read well and bisect, without
losing anything?" The page has three parts:

1. The history scan, which already existed: large blobs, secrets and messy messages, in `history_analyzer.py`.
2. The rewrite of the current branch.
3. The local branches to tidy.

## The plan

`rewrite.make_plan(repo, base)` reads the commits of `base..HEAD`, oldest
first (`commits.py`). By default `base` is where the branch left its default
branch: `origin/HEAD`, otherwise main, master, develop or trunk. Every git call
goes through `foundation.git_executable` with an argument list. A revision the
person typed is checked by `rev-parse --verify` first.

The plan is built by rules, with no model (`planner.py`):

| Step | When |
|---|---|
| squash (`autosquash`) | `fixup! X`, `squash! X`, `amend! X` join the commit X |
| squash (`fixups`) | a vague commit (`wip`, `fix`, `typo`…), or a small fix of files the previous commit touched, joins it, **only inside the same part of the project** |
| split (`mixed`) | a commit of 12 files or 400 lines spread over several parts becomes one commit per part |
| reword | a subject outside the project's convention |
| keep | everything else, message unchanged |

A "part" is defined in `domains.py` and is the same for every stack:

- `tests`, `docs`, `ci`, `db` (migrations, `.sql`, Prisma, Alembic, Flyway…);
- `build` (manifests and lock files: npm, pnpm, Cargo, Go, Maven, Gradle, NuGet/csproj, Composer, Bundler, pub, SwiftPM…);
- otherwise the first folder that names something, for example `frontend` for `apps/frontend/src/x.ts` and `Orders` for `src/Orders/Api.cs`.

So three Auth fixes and four Payment fixes give two commits, never one.

The convention comes from these sources, in order (`conventions.py`):

1. `.workpilot/git-surgeon.json`, which can set `conventional`, `gitmoji`, or `custom` with a regular expression. The file is data (S2): 16 KB at most, never read through a link, and the pattern is limited to 200 characters.
2. A commitlint or Commitizen configuration.
3. A gitmoji configuration.
4. The last 100 subjects: half of them following one convention is enough.
5. Otherwise, Conventional Commits.

The readability score is the share of subjects that follow the convention, before and after.

Every rewritten message keeps:

- its trailers (`Co-authored-by`, `Refs`, `Signed-off-by`…);
- its PR reference `(#123)`;
- its body.

A squash adds the other authors as `Co-authored-by` and lists the subjects it joined.

The plan also states what the rewrite costs:

- signed commits whose sha changes;
- commits already on a remote: replacing them there would need a force push, which WorkPilot never does;
- merge commits: the rewrite is refused until the start is moved after the last merge.

## The model, optional

"Word the messages with the configured model" sends the configured model, of
any provider (`core.oneshot`), the old messages, paths and line counts of each
rewritten step, quoted as data. It never sends the code.

An answer is kept only if it is one line of at most 100 characters that
follows the convention. Otherwise the rule-made message stays, so a run with
no model, or offline with no local model, still produces a full plan. The
page shows how many messages the model wrote.

## The replay

The page sends back the plan, edited or not. A message can be rewritten and a
step can be put back as it was. The main process checks the plan's shape
(`main/git-surgeon/input.ts`: shas, messages, paths, branch name) and writes
it to a temporary file for the runner. `apply.validate` then checks it again
against the repository: every commit of the range exactly once, a split only
over files its commit touches, no merge commit.

`apply.apply_plan` replays the plan in a temporary worktree started at the base:

1. Each commit is brought in with `git cherry-pick --no-commit`.
2. It is recorded with `git commit-tree`, which keeps the original author, email and date. No hook runs, as with `git rebase`.
3. The commits before the first change keep their sha, and so their signature.
4. A split stages each part's files in turn; the last part takes what remains.

Before anything is named, the result's tree must be the branch's tree, byte
for byte: only the history changes, never the code. The result becomes a new
local branch, `surgeon/<branch>-<date>` or a name the person chose.

The person's own branch, its remote and the tags stay as they were. Nothing
is pushed or forced. A conflict (a reordering that does not apply), a branch
that moved since the plan was made, or an invalid plan stops the run, and the
temporary worktree goes away with it.

Each applied plan adds one line to `.workpilot/git-surgeon/history.jsonl`, so
the page shows per month the number of squashes, rewords and splits, and the
readability reached.

## Branches

`branches.list_branches` lists, for each local branch:

- whether it is merged into the default branch;
- whether its upstream is gone;
- whether it is stale (no commit for more than 90 days);
- whether its name follows the `type/description` convention, with a suggested name when it does not.

`delete_merged` deletes only the branches that are local, merged into the
default branch, not current, not protected (main, develop…) and not checked
out in another worktree. It uses `git branch -d`, which itself refuses an
unmerged branch. Remote branches are never touched.

## Trust boundaries

- Every IPC channel takes a project the person added (`resolveKnownProject`). The history scan channel did not check this before.
- Every IPC channel takes only checked values. A plan or a list of branches goes to the runner through a temporary file, never through the command line.
- The runner runs without a shell.

## Not done

- **Splitting chosen by a model.** Commits are split along the parts of the project, by rules. A model only words the subjects.
- **Flattening merge commits.** The range has to start after them.
- **Renaming branches.** The page suggests a name; renaming stays with the person.
- **The "successful bisects" metric.** WorkPilot does not see the bisects people run.
