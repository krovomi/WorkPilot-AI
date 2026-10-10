# Token savings (rtk)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Token savings (rtk)

[rtk](https://github.com/rtk-ai/rtk) (rtk-ai, Apache-2.0) is a CLI proxy: it
runs the command it was given and prints a filtered version of its output.
Same behaviour, same exit code, a fraction of the bytes — 9 879 bytes of
`ls -la apps/backend` become 1 059 in this checkout, and `git status` 232 into
66.

That is worth wiring in because of where WorkPilot's input budget actually
goes. The prompts are written once and cached; what is paid for on every turn
of every phase is the *output of the commands the agents run* — a test suite,
a build log, a directory listing, a diff. Nothing in this repository was
looking at that number.

```
apps/backend/rtk/
  runtime.py    is there an rtk here, is it new enough, what is missing
  settings.py   RTK_ENABLED / RTK_MODEL_FACING, environment and .workpilot/.env
  rewrite.py    what rtk would run instead — delegated to `rtk rewrite`
  hook.py       the PreToolUse hook every agent Bash call passes through
  prompt.py     the paragraph that stops a model re-running condensed output
  capture.py    WorkPilot's own commands, when their output goes into a prompt
  stats.py      what rtk has actually saved, from rtk's own ledger
  api.py        GET /api/rtk/status
```

**One change reaches every feature.** Planner, coder, QA reviewer and fixer,
the spec pipeline, ideation, the GitHub runners, the self-healing responder,
the architecture map, the mobile phases — none of them run a command of their
own. They all go through `core.client.create_client`, so registering
`rtk_rewrite_hook` there covers the lot, and a phase added next month is
covered by having been written the normal way. The providers that do not use
the Claude SDK execute their shell commands in
`core/runtimes/tool_executor.py`, which is the same rewrite in the other
half of the product.

**The rewrite table is not reimplemented.** `rtk rewrite <command>` is the
same registry rtk's own shell hooks consult, and it answers through its exit
code — 0 rewrite, 1 no equivalent, 2 denied, 3 rewrite behind an "ask" rule.
It is a hundred commands deep and it moves with every release; owning a second
copy of it in Python would mean two answers to one question, drifting apart
silently. One subprocess per Bash tool call is the price, against a tool call
that is about to run a test suite.

**The hook never decides permissions.** rtk's own shell hook returns
`permissionDecision: "allow"` next to the rewrite, which is right for a person
at a terminal and wrong here twice over: whether an agent has the shell at all
is its declaration's answer (`create_client` denies `Bash` to every type that
does not declare it — see [agent-tool-rights.md](agent-tool-rights.md)), and the
command itself is judged by `bash_security_hook` and the guardrails. A third hook
voting "allow" while only knowing about bytes is a
second opinion on a settled question. So the hook returns `updatedInput` and
nothing else — it changes what a command prints, never whether it runs. rtk's
own deny rules are treated the same way: the command is left alone and
WorkPilot's allowlist decides.

**The allowlist never sees the word `rtk`.** This is the one place the feature
could have weakened something. rtk falls back to raw execution for anything
its table does not cover (`run_fallback` in its `main.rs`), so `rtk <anything>`
runs `<anything>` — and a validator reading the command name as "rtk" and
stopping there would have turned one allowlisted word into a door to every
binary on the machine. `security/parser.unwrap_rtk_prefixes` rewrites each
segment back to what rtk will run before anything is judged, and
`get_command_for_validation` hands the deep validators the unwrapped segment
for the same reason: every one of them opens with `tokens[0] != "git"`, so
`rtk git commit` would have reached the repository without its secret scan.
`rtk` stays in the base command registry only for its own meta commands
(`rtk gain`, `rtk discover`), which proxy nothing.

**A model that is not told will re-run the command.** Given forty lines where
it expected four hundred, the reasonable thing for an agent to do is doubt the
result and try again — and two extra turns cost more than the filtering saved.
`rtk.prompt.awareness_section` is appended by `build_base_system_prompt`, so
every provider branch gets it, and it is empty on a machine without rtk: an
agent told its output is condensed when it is not will second-guess perfectly
complete results. The text carries no version, path or count, because it sits
in the cacheable prompt prefix.

**rtk is for output a model reads, never for output code parses.** That is why
`core.git_executable.run_git` is deliberately untouched and there is no global
switch: `git status --porcelain` feeds a parser, `git diff --numstat` feeds a
counter, and condensing either saves nothing — none of it is ever sent to a
model — while breaking the caller. A call site opts in by calling
`rtk.capture_for_model`, which is a statement about where its output is going.
`agents/self_review.py` is the example to copy: three git calls, and only the
`git diff HEAD` excerpt that reaches the model goes through rtk. The test
runners in `qa/auto_fix_loop.py` and `self_healing/incident_responder/
cicd_mode.py` are the counter-example and stay raw, because their output feeds
`_parse_test_counts` and `_parse_failing_tests` before it feeds a prompt.

**Nothing here can fail a build.** rtk absent, too old, turned off, timing
out, crashing, printing something unexpected: the command runs exactly as
written. The worst the integration can do is cost a session two seconds.

| Variable | Default | What it does |
|---|---|---|
| `RTK_ENABLED` | `true` | The master switch. "On" costs nothing without rtk — every entry point answers in a cached `shutil.which` |
| `RTK_MODEL_FACING` | `true` | Whether WorkPilot's *own* captures are condensed too. Separate because it changes what a code path receives, not only what a model reads |
| `WORKPILOT_RTK_PATH` | — | A specific binary, for a build that is not on PATH and for tests |
| `RTK_DISABLED` | — | rtk's own escape hatch, honoured rather than rewritten into a no-op |

Both switches are read from `.workpilot/.env` as well as the environment, so
Settings → Agent Tools → Token savings reaches the hook, the awareness
paragraph and the captures from one place. Real environment variables win.

**In the UI.** `RtkSavingsCard` in the task panel reports the conditions and
what rtk has recorded for this project, and renders nothing at all when rtk is
not installed — a permanent card reading "feature not in use" is a card nobody
reads. Discovery happens in Settings instead, which is where one goes to look
for what could be switched on. Neither surface has an install button:
`rtk init -g` writes a hook into the user's own Claude Code settings, for every
session on the machine and not only the ones WorkPilot drives, so — like the
hermes trust gate — the panel prints the command and the person types it.

The savings figure is reported as what was measured and nothing more. rtk
ships no tokenizer and estimates tokens as bytes / 4; shell output is one input
among prompts, history and system instructions, which are themselves the input
half of a bill that also pays for output. The extrapolation is made by nobody.

**How it is verified.** The layers split by what they need, the same way the
mobile toolchain does:

| Layer | Proven by | Where |
|---|---|---|
| the exit-code protocol, the hook, the failure paths | a fake rtk that answers a chosen code | `tests/test_rtk_rewrite.py` |
| the allowlist seeing through the proxy | the real parser and the real validators | `tests/test_rtk_security.py` |
| the capture rule, and self-review honouring it | a fake rtk, and the module's own source | `tests/test_rtk_capture.py` |
| that rtk still behaves the way this integration assumes | whatever rtk is really installed | `tests/test_rtk_contract.py` |

The last row exists because every assertion in the first three is fed a string
somebody here wrote: they test our idea of rtk. The contract tests assert what
must hold *whatever* version is installed — that `rtk rewrite` answers with one
of its four codes, that a rewrite is a command line, that the exit code
survives, and that a command rtk rewrote still names itself to the allowlist —
and never that a particular command is condensable, because rtk's table grows
and shrinks and a test pinning one entry of it gets disabled within a month.
They skip when rtk is not installed.
