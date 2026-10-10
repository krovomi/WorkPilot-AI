# Competitive rounds (Bounty Board)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Competitive rounds (Bounty Board)

N contestants, each a `(provider, model, prompt_override)` triple, implement the
same spec concurrently in their own git worktrees. A judge then measures what
each one left on disk and proposes a winner.

```
apps/backend/bounty_board/
  board.py    orchestration: worktrees, concurrency, persistence
  runner.py   how one contestant is run — `create_agent_client(provider=…)`
  signals.py  what it produced: diff and the project's own test suite. No model
  judge.py    what that is worth
```

**The board used to score a string nobody had generated.** `runner` opened with
`from llm_client import acomplete`: the module is `core.llm_client`, the runner
puts only `apps/backend` on the path, and `acomplete` exists in it under no
name. So the import raised on every run and the `except ImportError` handler —
written for an environment where the multi-provider client "was not wired up
yet" — produced `f"[stub:{provider}:{model}] {prompt[:200]}"`. That string
embeds the contestant's own `provider:model`, so the only thing that varied
between contestants was **the number of characters in their model's name**. A
real round reported 77.9 / 77.8 / 67.9 and crowned a winner with two decimal
places of confidence. The warning that said so went to a logger nobody reads:
the runner is spawned by Electron and its stderr surfaces only on a non-zero
exit.

There is no stub any more, and that is the point rather than an omission. A
contestant whose client cannot be built ends `error` with the reason on its
card. An invisible wrong answer costs more than a visible failure.

**And the judge scored prose.** Its four terms were completion (50 points for
not crashing), coverage (the *first word* of an acceptance criterion found as a
substring anywhere in the answer), output length, and latency rank. Three
measure the shape of the answer text; the fourth measures the field. Five rules
replace them:

| Rule | What it prevents |
|---|---|
| **score the artifact** — every criterion reads the diff or a command run against it | a contest decided by how much the model wrote |
| **absent evidence renormalises, never scores zero** — `Criterion.value is None` drops that weight out of the total | a project with no test suite reading as a project whose tests fail |
| **no criterion is a rank** — efficiency is a ratio to the *best*, floored at the resolution below which a difference is noise | `1 - duration/slowest`, which gave the slowest exactly 0 whatever the gap: one millisecond cost ten points |
| **efficiency is a tiebreaker, never a verdict** — dropped entirely unless `tests` or `spec_fit` was measured | a score built only out of "returned first" |
| **the judge does not know who it is judging** — diffs arrive as `Candidate 1..N`, provider and model stripped | a judge measuring reputation |

Weights are `tests` 55, `spec_fit` 35, `runtime` 20 (the contestant's
`verify` record: the app seen running, and its performance score), `efficiency`
10, renormalised over whichever had evidence — so they are ratios between
signals, not points. Two
gates come before any of them, because both describe a contestant with nothing
to score rather than one that scored badly: a status other than `completed`,
and a measured empty diff.

**`null` and `0` stay apart all the way to the card.** `quality_breakdown`
carries `null` for a criterion with no evidence, and `ContestantCard` renders
*not measured* in italics rather than `0.0`. Collapsing the two is how an
unmeasured contest comes to be read as a close one, which is exactly what
happened. Every dropped signal is also reported as a `warning` on the result and
listed in the verdict modal.

**A tie is reported as a tie.** The old `scored.sort()` was stable, so equal
scores handed the trophy to whichever contestant was declared first — at the
0.1-point margins that board produced, most rounds. `evidence_judge` returns no
winner and says the top score was tied.

**The test suite runs sequentially, once per contestant.** N suites racing over
the same ports, temp files and package caches measures the contention. And a
suite is never run against an empty diff: it would measure the base branch and
hand every do-nothing contestant a clean pass.

What `discover_test_command` returns is a CI `run:` block, which is a shell
script rather than an argv list — in this repository, `source .venv/bin/activate`
followed by `pytest`. So it is executed as one, through
`asyncio.create_subprocess_shell`, the same call `qa/auto_fix_loop._run_tests`
already makes for the same question; a `subprocess.run(shell=True)` here is both
a second answer to it and a fifteen-minute block of the event loop the
contestants ran on. The suite gets its own process group, so a timeout takes the
dev server or database it started with it rather than leaving them holding the
ports the next contestant needs — and a timeout is `unknown`, never a failure the
contestant caused.

**Credentials for every provider, and no `SELECTED_LLM_PROVIDER`.** This is the
one run that talks to several providers at once, so `bounty-board-handlers.ts`
merges `credentialManager.getEnvironmentVariables(provider)` for each and then
deletes that variable: every contestant names its own provider, which
`create_agent_client(provider=…)` honours directly, and an ambient one would be
a second answer to a settled question.

**The base of that environment is `getRunnerEnv`, not a second assembly.** It
used to be built out of `credentialManager` alone, and that object never
carries Claude's *own* authentication: the OAuth token comes from
`getBestAvailableProfileEnv` and an API profile from `getAPIProfileEnv`, both
of which every other runner in the application receives through `getRunnerEnv`.
So a Claude contestant was dispatched with no Claude credentials at all and
died on `No OAuth token found` — on an authenticated machine, in the same round
where OpenAI and Google reached their providers. Two assemblies of one
environment is how one of them quietly loses a variable, and the symptom looks
like an authentication bug rather than a wiring one.

Claude's chain is therefore left to `getRunnerEnv` and never re-stated: it
resolves OAuth mode, API profiles and rate-limit-aware profile swapping
*together*, and re-injecting a key on top of it could contradict the mode it
just chose. Only the board's other providers are layered on.

`prompt_override` reaches a model now. It was parsed from the CLI, stored on
`ContestantSpec`, and dropped by `_materialize`, so the per-entry strategy the
UI offers had no effect on anything. It is added to the brief, never
substituted for it.

**A provider with no agentic adapter never takes the field.** meta, aws, cursor
and custom are driven by the Claude SDK (`capabilities/providers.yaml`,
`degrades_to`) — mistral, deepseek and grok have their own
(`CompatibleProviderAgentClient`) and do take it. That fallback is the right trade for a build,
since the task runs, and the wrong one for a contest, where a win would be
recorded under the name of a vendor that never saw the prompt. It is the Arena's
`require_provider` rule, word for word, and `bounty_board/runner.py` applies it
before a client is built: that contestant ends `error` with the reason on its
card. The selector says so too, from the same matrix the Arena reads
(`GET /providers/agentic-capabilities`, via `useAgenticCapabilities`), so the
answer arrives before a round is spent learning it rather than after.
