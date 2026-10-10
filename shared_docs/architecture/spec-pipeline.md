# Spec pipeline: plan recovery, traceability, spec-kit

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Where the implementation plan actually is

> *Planning failed: the model did not produce a valid implementation_plan.json
> (unparseable or missing `phases`). — No phases defined — No subtasks defined
> in any phase*

That sentence was the answer to a question nobody had asked. The validator
reads one path, in one shape, and reports what it did not find there; it was
then repeated three times and the build gave up. Three other things are true
far more often than "the model produced nothing", and none of them costs
another planning session to fix:

| What happened | Where the plan was |
|---|---|
| PHASE 3 of `prompts/planner.md` spelled the destination as a **relative** `implementation_plan.json`, which resolves against the worktree root | `<project_dir>/implementation_plan.json` — the file `_cleanup_stray_root_plan` used to **delete** |
| the model invented a filename | `plan.json`, `tasks.json`, `subtasks.json`, in the spec directory |
| it wrote the right file in a shape the schema does not name | `tasks` / `steps` / `stages` instead of `phases`, one level of `{"implementation_plan": {…}}`, `phases` keyed by id, a subtask that is a bare string, the whole document inside a ```` ```json ```` fence |
| it wrote **`"phases": []`** and put the work one key lower | `{"feature": …, "phases": [], "tasks": [{…}]}` — the shape PHASE 3 warns against by name, which is why a model produces it |
| its Write was **refused** and the content dropped | the `tool_use` input in `conversation.<provider>-<model>.jsonl` |
| it never called Write at all | the JSON is in the planner's own response |

`spec/plan_recovery.py` answers the question in two halves, both usable alone:

| Function | Answers |
|---|---|
| `extract_json_document` | the first complete JSON document in a blob that may be fenced or wrapped in prose — depth-counted, so a `"map[0] of {x}"` inside a string does not close it early |
| `normalize_plan_shape` | a parsed *anything* → `phases[].subtasks[]`, or `None` |
| `recover_plan` / `write_recovered_plan` | the same normalization applied to every place the plan could be, writing the winner to the one path WorkPilot reads |

`validate_pkg.auto_fix` calls the first two on the file the validator reads, so
the CLI and the spec pipeline get the reshaping too; `agents/coder.py` calls
`recover_plan` as the third step of `_validate_and_fix_implementation_plan`,
after validation and after auto-fix, and **prints where the plan came from** —
this is the one point where WorkPilot builds from a file it moved or reshaped
on the model's behalf, and a silent rewrite would leave the next reader
comparing the plan against a transcript that does not match it.

**Reshaping is not inventing.** The only things added are the fields the schema
requires and the model left implicit: `status: pending`, ids, a phase to hold a
flat list. A *description* is never synthesised, because that is the only field
carrying a decision. When nothing anywhere holds a single subtask,
`normalize_plan_shape` returns `None`, and planning fails with exactly the
message above — which is then true. A plan WorkPilot made up would be worse
than the error: the coder would spend a whole build implementing it.

**An empty `phases` proves nothing.** `normalize_plan_shape` used to read the
key it found and stop: `phases` was *present*, so the flat list one key lower
was never looked at, and a plan whose subtasks were right there reached the
validator as "No phases defined / No subtasks defined in any phase" — the one
report that claims a model produced nothing while it had produced a plan. The
phases key and the flat list are now both tried, in that order, and only a
document where neither carries a subtask returns `None`.

**A refused write is where the plan of a non-Claude provider goes to die.**
The recovery above reads files and response text, and a provider that does not
use the Claude SDK puts its plan in neither: it calls `Write`, and
`tool_executor._write_implementation_plan` used to reject any content
`json.loads` refused — a ```json fence, a sentence in front of it — and return
the error. Nothing was written, so no file existed to repair; the plan was in
the tool call, not in the prose, so there was nothing to salvage from the
response either. Three planning sessions were spent on a plan WorkPilot had
been handed and thrown away. Two layers answer it now, and they are
independent on purpose:

| Layer | Answers |
|---|---|
| `tool_executor._write_implementation_plan` | the fence and the surrounding prose are stripped by the same `extract_json_document`, and the document is written — even when it is not an object, because a bare `phases` array is still the only copy. Only content with no JSON document in it is refused, and that error still goes back to the model |
| `plan_recovery._plan_from_tool_calls` | the plan out of a `Write` that never landed, read from the conversation log's `tool_use` inputs, newest call first. The last place it can be, and the one both other sources miss |

The second layer is as strict about the destination as the file search is: the
asked-for name counts anywhere, an invented name only when the write was aimed
*inside* the spec directory, and a relative path never — a tool call's content
is any file the model wrote, and building an arbitrary one is worse than
failing. A write aimed at `src/Program.cs` is not a plan however well its
content parses.

**A document that is not an object is reported, not crashed on.** Every check
in `ImplementationPlanValidator` reads the plan as a mapping, so a model that
wrote the bare `phases` array took the build down with an `AttributeError` deep
in validation and the card showed a crash instead of what was wrong with the
file. It is an ordinary validation error now, which is what lets the reshaping
above run at all — recovery only happens after the validator has answered.

**Two rules keep recovery from finding the wrong thing.** Outside the spec
directory only the asked-for name is read — `tasks.json` at a project root is a
task-runner config far more often than it is a plan, and building somebody's
build config is a worse failure than the one this fixes. And a file found
outside the spec directory is *moved*, not copied: a second copy of the real
plan at the worktree root is worse than the truncated one `_cleanup_stray_root_plan`
removes, because a later read could pick it up.

The status bookkeeping the frontend keeps in `implementation_plan.json` before
the plan exists (`persistPlanStatusAndReasonSync` creates the file with
`status`, `xstateState`, `executionPhase` and no `phases`) is merged back over
the recovered plan. It describes the task, not the plan, and dropping it resets
a card that is visibly running.

## Requirement Traceability

`spec.md` names its requirements — `FR-001`, `NFR-001` — and every subtask in
`implementation_plan.json` claims the ones it implements:

```json
{ "id": "subtask-1-1", "requirements": ["FR-001", "FR-002"], ... }
```

Positions are not names. Numbering requirements `1.`, `2.`, `3.` meant inserting
one in the middle silently repointed every reference to the ones below it, so
nothing downstream referenced a requirement at all — and "which requirement is
covered by no subtask?" had no answer until QA read the finished branch.

`spec/traceability.py` is the single reader: `parse_requirements`,
`parse_open_questions`, `compute_coverage`. The parsing takes text, so the
validators, a workflow phase and a test all use it the same way.

Once the plan validates, `write_record` puts the answer in
`<spec_dir>/traceability.json` — requirements, open questions, and the coverage
map — and the coder loop prints the summary. That is the last moment a missing
requirement is cheap: the plan is valid, no code has been written against it,
and the fix is a sentence. The `analyze` phase, the Kanban and QA read that
record rather than each re-parsing `spec.md`; three parsers of one document is
how three answers to one question start.

**`[NEEDS CLARIFICATION: <question>]`** marks an assumption the inputs could not
settle. `spec_writer.md` used to be told to "make reasonable assumptions" full
stop, and in the finished document a guess reads exactly like a decision
somebody made. The marker keeps the two apart and makes the guesses countable.
It is not an escape hatch: a question the codebase or `context.json` answers is
work, not a clarification.

Both signals are **warnings, never errors**, in `validate_pkg`:

| Reported | Why not an error |
|---|---|
| open questions in `spec.md` | flagging what you do not know is the spec doing its job |
| no `FR-###` ids at all | specs written before ids existed are not broken |
| a requirement no subtask claims | it can be deliberately out of scope — the plan's author decides |
| a subtask referencing an undeclared id | the two documents drifted; which one is wrong is a judgement |

Coverage reports *not applicable* rather than 0% when the spec declares no ids —
a legacy spec scoring zero on every build teaches everyone to ignore the line.
And an error here would reach the validation auto-fix agent, whose cheapest way
to satisfy it is to bolt an id onto the nearest subtask: a signal that is always
green and always meaningless.

The quick path (`spec_quick.md`) takes the marker and skips the ids: identifiers
earn their keep when a plan has several subtasks to trace, and a quick spec
usually has one.

**In the Kanban.** `GET /api/spec-traceability/` (`spec/api.py`) answers the
same question at any moment, and `SpecTraceabilityCard` renders it in the task
panel — but only when there is something to say. A spec with nothing open and a
plan that claims everything renders nothing: a badge that is green 95% of the
time is a badge nobody reads. The endpoint **recomputes** rather than reading
back `traceability.json`, because the panel is opened most often on tasks that
have never been planned, where the file does not exist and the answer still has
to be right. Like `workflows/api.py`, it is refused in server mode — a client
naming a directory on a shared server is a cross-tenant read — so it is a
desktop feature until a `project_id`-addressed endpoint exists.

**Before the spec exists**, the clarification is already someone else's job:
`SpecInterviewBanner` asks 3-5 questions on a backlog task and appends the
answers as a `## Clarifications` section. Its prompt now sweeps nine coverage
areas (scope, data model, UX flow, non-functional, integrations, failure
handling, trade-offs, terminology, completion signals) and marks each Clear,
Partial or Missing before choosing what to ask — adapted from spec-kit's
`/speckit.clarify`. The sweep is not reported; it decides which five questions
get asked. Given a budget and no map, a model spends its questions on the area
the description already talks about most, because that is where it has the most
to say — so a spec that never mentions failure handling was never asked about
it.

## spec-kit projects

[spec-kit](https://github.com/github/spec-kit) (GitHub, MIT) is a
spec-driven-development toolkit, and a project initialised with it keeps its
binding rules in `.specify/memory/constitution.md`. WorkPilot builds other
people's projects; when one of them is a spec-kit project, those rules are the
house rules, and a plan written without them is one the project's own tooling
would reject.

`project/spec_kit.py` reads that one file, and `prompts.constitution_section`
is the single wrapper that hands it to everyone who needs it: the planner,
every coding subtask, the QA reviewer, and every skill phase the workflow runs.
There is nothing to install and nothing to configure — a project without
`.specify/` costs one `is_file()` call and produces no prompt section at all.

Those four readers are the point, not an afterthought. QA is the phase that
decides whether the result is acceptable, and `analyze` is asked outright what
the plan does that the project forbids; both were answering from conventions
they had inferred out of the codebase while the project had written its rules
down. A finding that cites the constitution is at least `HIGH`, because the
project wrote it precisely where inference was getting it wrong.

**Only the constitution.** spec-kit also keeps `specs/###-name/spec.md` and
`tasks.md` — its own equivalents of `spec.md` and `implementation_plan.json`.
Reading those would mean deciding which of two specs a build is following, and
that question has no good answer: WorkPilot has its own spec, written by its own
pipeline, for this task. The constitution is different because it is not about
this task at all — it is about the project, and it holds whichever spec is
driving the work.

The document goes in whole rather than as extracted rules: a `MUST` quoted out
of its section loses the scope that qualified it, and a sentence about what the
project *used* to require would be quoted as current law.
