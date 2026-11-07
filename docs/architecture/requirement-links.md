# Requirement → files → tests, kept after the task (prospective P3)

When generating code costs little, the spec and the tests become the
reference, and the implementation what gets regenerated. That needs a link the
pipeline did not keep: which code and which tests a requirement produced.
`traceability.json` (`foundation/traceability.py`) stops at "subtask `s1`
claims `FR-002`", and lived in the task's spec folder only.

## What is linked

`requirement_trace.compute_links`, at the end of a build (after the hard
gates, `cli/build_commands.py`):

| Link | From | When it is missing |
|---|---|---|
| requirement → subtasks | the plan's references (`compute_coverage`) | the requirement is unclaimed, as before |
| subtask → files | the files Agent Trace recorded for each session of the subtask (F3, `agent-trace.jsonl`), restricted to the task's real diff | no session record: the subtask's declared `files_to_modify` / `files_to_create`, and `source: plan` says so |
| files → tests | the repository's naming conventions (`foundation.touched_tests`, every stack it maps: Python, TS/JS, .NET, JVM, Go, Rust, PHP, Swift, Dart, Ruby, Elixir, C/C++), plus the test files the subtask wrote | a source file a convention maps with no test is listed in `untested`; a README or a language no convention reads is neither tested nor untested |

A link without evidence is absent, never inferred from a title. The record
holds paths only, never code.

## Where it is kept

- `requirement-links.json` beside each copy of the spec (the worktree's and
  the project's);
- the project's ledger, `.workpilot/requirements/<spec>.json` in the main
  checkout, which outlives the worktree and the task. A linked ledger folder
  or entry is refused.

## Who reads it

`GET /api/spec-traceability/` adds `links`, read back from the spec (never
recomputed), with `earlier`: the requirements of other tasks, from the ledger,
that touched the same files. The task's traceability card shows each
requirement's files and tests, the requirements without a test, and the
earlier ones on the same files, so a change that walks over earlier work says
so before review. Like the rest of that route, it answers in desktop mode
only.

Next steps the plan names, not done here: proposing to regenerate the code and
tests of a requirement whose text changed, and flagging spec/code drift.
