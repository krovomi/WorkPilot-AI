# Mutation gate `tests-bite` (F7)

Coverage says a line ran, not that a test would fail if the line were wrong: a
test that builds the object and checks it is not null satisfies the coverage
gate. The mutation gate answers the reviewer's question about an agent's PR,
*do these tests protect anything?*, on the lines the task wrote only, so its
cost is bounded.

```
apps/backend/mutation_gate/
  mutator.py   the generic lexical mutator: any stack, never in a comment or a string
  native.py    StrykerJS and cargo-mutants when the project has them; their report file, never their console
  scope.py     the lines to mutate: git diff against the review's base, working tree and untracked files included
  commands.py  the stack's test command as an argument list, narrowed to the file's tests where the runner allows
  sandbox.py   the throwaway copy (detached git worktree + pending changes + untracked files, dependencies linked)
  engine.py    selection, baseline run, one run per mutant, the score
apps/backend/qa/mutation_gate.py   the QA gate, the fix request, the test-only guard on the fixer
apps/backend/workflows/hard_gates.py  `tests-bite`, read from <spec_dir>/mutation_gate.json
```

## When it runs

After the reviewer approved and the dependency, architecture and coverage
gates passed (`qa/loop.py`). Only when someone asked for it:

- the task's workflow declares the hard gate `tests-bite` (the `test`
  workflow: a task that writes tests is exactly where "do they bite" is the
  question), at a 60 % threshold;
- or `WORKPILOT_QA_MIN_MUTATION` is above 0: every task, at that threshold.

`WORKPILOT_QA_MIN_MUTATION=0` switches it off. The record then says so and
the hard gate reads *unknown*, never a pass. A value that is not a number
falls back to 60: a typo must not switch a gate off.

## What it mutates

The new-side lines of `git diff -U0 <base>` for each source file of the
change set (tests, vendored and generated folders, and languages the mutator
does not read are skipped), plus the untracked files whole. A task that wrote
only tests (the `test` workflow) mutates the sources those tests are the
tests of, by the naming conventions of `foundation/touched_tests.py`.

The generic mutator inverts, one at a time: `==`/`!=`, `===`/`!==`,
`<`/`<=`, `>`/`>=` (only between spaces, so `List<int>`, `=>`, `->`, `<-`,
shifts are left alone), `&&`/`||`, `and`/`or`, `true`/`false`
(`True`/`False`), `+`/`-` between spaces. Comments and strings are blanked
first, by family (`#`, `//` and `/* */`, both for PHP; triple quotes,
backticks, C# verbatim strings, Rust lifetimes and chars). Imports,
`using`, `package`, annotations and type declarations are skipped.

At most 20 mutants, one file after the other (the plan's files first),
spread over each file's lines.

## Where it runs

Never in the task's worktree: a mutant left behind by a crash would ship. A
detached `git worktree` of HEAD, the pending changes applied (`git diff
--binary HEAD | git apply`), the untracked files copied (no `__pycache__`).
The dependency folders git ignores (`node_modules`, `.venv`, `venv`,
`vendor`, to depth 3) are linked, a junction on Windows when a symbolic link
needs a privilege: nothing is installed, so it works offline and in
`airgapStrict`. The links are removed first, then the worktree, in a
`finally`.

Each test command runs once on the unmutated copy; it must pass. Then each
mutant alone, with a timeout of three times the baseline plus ten seconds
(30 s at least): a failing or timed-out run *killed* it. Every write gets a
new modification time and Python writes no bytecode: a mutant of the same
size written in the same second would otherwise run the stale `.pyc`. The
children run without the backend's credentials (`security/child_env.py`),
without a shell, in their own process group, killed as a tree on timeout.

When the project has StrykerJS (`@stryker-mutator/core` in its
dependencies) or `cargo-mutants` is on the PATH, the native tool runs instead,
limited to the diff (`--mutate file:first-last`, `--in-diff`), and its report
file is read (the mutation-testing-report schema, which Stryker.NET writes
too; `mutants.out/outcomes.json`). A native tool that fails or writes no
report falls back to the generic engine.

## The verdict

Score = killed / (killed + survived).

- **pass**: the score reaches the threshold; also when the diff holds no
  source line, or no operator to invert (nothing for a test to protect);
- **fail**: below it, with the survivors (`file:line`, the mutation);
- **unknown**: no test command for a file, the suite red before any
  mutation, the time budget (15 min) spent, the copy impossible. Never a pass
  by default (rule 12): `tests-bite` holds only on `pass`.

A `fail` rejects the QA pass. `QA_FIX_REQUEST.md` names each survivor as a
missing test (« the tests still pass when `>= becomes >` at `Order.cs:42` »)
and allows test files only. After that fixer session, every non-test file it
changed since the rejection is restored and the restore is committed:
changing the code to make a mutant disappear proves nothing.

## Not done yet

- The LLM judge of equivalent mutants (the ACH paper's): a survivor it would
  set aside must stay listed, and it can never declare tests sufficient.
- A "Mutation" section on the card, with survivors linked to the guided
  review's diff (F4).
- Native runners for PIT, Infection, mutmut and Stryker.NET: the generic
  engine covers those stacks today.
