# hermes-agent

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## hermes-agent

[hermes-agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT) is
supported, and the integration is deliberately small — because most of it already
existed.

**As a harness, nothing is emitted.** Hermes scans `<project>/.hermes/skills/` *and*
`<project>/.agents/skills/` at the git root, and injects `AGENTS.md`. Both are already
built and committed here, so `capabilities/harnesses.yaml` points its entry at the
agnostic path. A `.hermes/` mirror would duplicate ~390 files to say the same thing
twice and put `skills:check` in charge of policing two copies.

What it does need is one command in the checkout:

```bash
hermes skills trust
```

That is hermes's own trust gate, and it is right: project skills are load-on-demand
procedures an agent will follow, so auto-sourcing them from any cloned repo is a
prompt-injection vector. It is a per-machine decision by a person; nothing in this repo
makes it.

**Not in `providers.yaml`.** Hermes is an agent runtime, not an LLM provider — its own
loop, tools and model routing. Listing it there would claim WorkPilot can drive a task
on it.

**As a pack, `skills/hermes` is opt-in and scoped.** hermes-agent is a product that
ships skills, not a skill collection: hundreds of them, covering smart-home and
social-media alongside software development. `skills:bootstrap --pack hermes` takes
three categories and excludes the skills another tracked pack already provides —
`test-driven-development` is upstream's own adaptation of `obra/superpowers`. What is
left is what it genuinely adds: `systematic-debugging`, `spike`, the two runtime
debuggers, `merge-reconciler`, `sdlc-review`, and the procedures for driving Claude
Code, Codex and OpenCode.

**As a proposer, its learning loop feeds ours.** Hermes writes skills from its own
experience, on surfaces WorkPilot never sees — Telegram, Discord, a cron job on a VPS.
Two closed loops writing skills is one too many, so there is no second loop here:
`learning_loop/hermes_ingest.py` files each authored skill as a *candidate* under
`skills/_proposed/`.

**Only what hermes says it authored.** `skill_manage` writes `created_by: agent` into
`~/.hermes/skills/.usage.json` for a skill the agent wrote, and nothing of the sort for
one that was shipped or downloaded — so that record is the rule, and the shipped
(`.bundled_manifest`) and hub (`.hub/lock.json`) lists subtract on top of it. The
approval queue `pending/skills/` is admitted unfiltered: a skill is in it only because
the agent just wrote it, and its record is written on approval.

It started the other way round — everything except `.bundled_manifest` — and that shape
fails open twice over. It is a denylist against a catalogue upstream keeps growing, and
the manifest is `name:hash` per line, not JSON, so reading it with `json.loads` raised on
every line, the exception was swallowed, and the exclusion matched nothing. One build
proposed sixty upstream skills, `airtable` and `imessage` among them. The test that was
supposed to catch it wrote the manifest as JSON: it encoded our idea of the format
instead of the format. A denylist that fails open floods the queue; an allowlist that
fails closed proposes nothing, which a person notices and nothing is harmed by.

**And only what this repository has a use for.** The rule above reads files
*upstream* owns, which is right for the question it answers — what did hermes
write? — and is the one property that keeps failing. It failed by parsing
`.bundled_manifest` as JSON; it failed again on an install whose `.usage.json`
claims authorship over the shipped catalogue and which ships no manifest to
subtract. Both times the symptom was identical: sixty-one candidates, `airtable`
and `imessage` among them, and a person asked to delete them one by one. A third
fix to the reading of upstream's files would be the third version of the same
mistake.

`learning_loop/hermes_triage.py` is a **second authority**, and its inputs are
facts this repository owns:

| Read from | Answers |
|---|---|
| `skills/hermes/pack.json` (`--subdir`) | which of hermes's categories this project tracks |
| the same file (`--exclude`) | which names it looked at and turned down |
| `skills/<pack>/`, `skills-lock.json`, `.agents/skills/` | which skills it already provides |

The two authorities fail in opposite directions — hermes's bookkeeping fails
open, because an absent file excludes nothing; the scope fails closed, because an
unreadable `pack.json` leaves the declared default and an unknown category is out
of scope — so a flood now needs both to fail at once, and the second one cannot
fail by upstream shipping a release. Four reasons, all reported rather than
merely applied (`DROP_REASONS`): `already-provided`, `declined-here`,
`out-of-scope`, `upstream-catalogue`.

The last one is the rule for a hermes home kept flat, where there is no category
directory to compare against — which is the shape the sixty-one arrived in. It
reads the frontmatter: hermes's own authoring standard requires `author` and
`license` of a skill contributed to its repository, and requires neither of a
skill `skill_manage(action='create')` writes from a session's experience. A
locally authored skill carrying both is turned away, and that is the error worth
making — one skill nobody had yet, against sixty files nobody wanted. The
exception is hermes's approval queue: a skill is in `pending/skills/` only
because the agent just wrote it, so the fingerprint is not asked of it. That is
the one input whose provenance is not a record that can fail open, and silencing
it would cost the loop its best source.

**A rule that changed reaches the files the old rule produced.** Every cycle
withdraws the queued candidates a fresh verdict turns away, before it looks at
what hermes has — sixty files filed under a broken rule are one bug, not sixty
decisions somebody took, and the alternative is charging their owner for it. Only
files the ingest itself wrote are eligible (`recorded_facts` returns nothing for
anything else, so the learning loop's own evidence-carrying proposals are never
touched), and a legacy candidate that recorded neither its category nor its shape
is re-derived from the source path it does record. `GET /api/hermes/status` and
the Kanban card therefore report *what is left to read*, not what is on disk:
stale candidates are a number, not sixty rows, and the read does not delete them
— the next cycle does.

What triage does **not** move is the gate. A candidate that passes it still
carries no evidence from a build that used it, so it is filed and promoted by
nothing; `skill_proposer.evaluate` still refuses to invent corroboration. The
autonomy added here is over the chore, not over the decision.

**And the last chore goes too: `learning_loop/hermes_adopt.py` writes what
survives triage into `skills/hermes-learned/`.** The step it replaces was pure
transcription — open the candidate, copy the body into `skills/<pack>/`, delete
the candidate — and a queue whose only exit is a copy-paste is a queue that
fills up.

What makes that safe is not that the prose is trusted. `.workpilot/skills.toml`
is a want-list: `resolver.resolve` rejects every skill of a pack the project has
not listed, at the `pack-pin` gate. That pack is deliberately **not** listed, so
nothing in it is emitted to `.agents/skills/` or to any harness, and no agent can
load one. Auto-adoption writes agent-authored prose into the repository; it does
not make any agent follow it. The act that would — one line in `[packs]` — stays
with a person, is taken once rather than per skill, with the whole pack in front
of them, and is the moment to do the portability rewrite each file describes
(`adopted: verbatim` and the tool table say so in the file). Until then the
adopted file is an ordinary diff in the pull request of the task that adopted it,
reviewed like everything else here rather than in a queue that exists on one
machine — which is also why it is committed while `skills/_proposed/hermes--*.md`
is ignored.

**Adoption is one-way, and once.** Nothing deletes from the pack and nothing
rewrites a file already there, because the two things a person does with one are
the two things a loop must not undo: rewriting it (the portability pass — a
refresh from hermes would throw that away on the next build) and deleting it,
which is how you say no. `ADOPTED.json` records every name ever adopted, so a
deleted one is never re-adopted; without it the person deletes it again on every
build, for ever.

The queue keeps its copy, and that is deliberate: `skills/_proposed/hermes--x.md`
is the live mirror of what hermes has on *this* machine, refreshed when hermes
edits its own skill, while the adopted file is the snapshot the project took.
`queue_state` leaves a settled name out of what it reports, so nobody is asked
about it twice. And `hermes-learned` is the one pack `hermes_triage` does not
count as "already provided" — the others are decisions a person took about a
name, that one is the loop's own output, and counting it would have the loop mask
its own inputs one build later.

| Variable | Default | What it does |
|---|---|---|
| `HERMES_AUTO_ADOPT` | `true` | Adopt what survives triage. Off leaves the review queue as the only destination. On by default because the pack reaches no harness: the cost of being wrong is one file in one diff |

```bash
python3 scripts/skills_cli.py hermes-ingest --dry-run
python3 runners/hermes_runner.py --action status
python3 runners/hermes_runner.py --action cycle --surface kanban
```

### The cycle, and who may open it

`apps/backend/hermes/` is the capability; the ingest above stays in `learning_loop/`
because that is where the review queue and its rules live.

| Module | Answers |
|---|---|
| `home.py` | where hermes keeps its state, and what the user configured there |
| `soul.py` | the persona this repository offers, and whether it is installed |
| `readiness.py` | whether the loop can run in this checkout, and what is missing |
| `loop.py` | the cycle itself, opened by a named feature surface |
| `api.py` | `GET /api/hermes/status`, `POST /api/hermes/cycle`, `POST /api/hermes/review`, `POST /api/hermes/soul/install` |
| `brain_link.py` | what hermes learned, filed in the shared brain — and whether hermes reads it back |

The three steps that always go together — *can this run here*, *what did hermes
author*, *who asked* — are one function, and a **surface** is a name rather than a code
path: `build` (the `observe` phase), `kanban` (the task panel), `cli`, `self-healing`
(the end of an incident cycle, in `incident_responder/orchestrator.py`'s healing
pipeline — in a `finally`, because a pipeline that failed is not a reason to skip the
question, and reporting a step only when it filed something, since a "0 proposed" row on
every incident is a row nobody reads), `github`. `SURFACES` is a closed set on purpose, because the surface is written into a
file a person reviews and a free-text field would fill with whatever string each caller
happened to pass. The next feature to want the loop adds a line there, not a second
ingest.

The surface is recorded on the candidate, which is what lets a reviewer reading
`skills/_proposed/` six weeks later tell a build's observation from a person pressing a
button. That is the difference between a queue and a pile.

**The doctor runs before the phase, not after the empty result.** Five conditions —
`install`, `soul`, `trust`, `skills`, `agents` — all answerable from files on disk in
milliseconds, which is why the Kanban can ask on every panel open. Only `install` is a
blocker; the rest degrade, because a candidate hermes authored *elsewhere* is exactly
the experience from outside this repository that makes the integration worth having.
The failure this exists to prevent is the silent one: `trust` is unset on every fresh
clone, hermes then loads no project skills, nothing appears, and the conclusion drawn
six weeks later is "hermes doesn't work here".

**There is no endpoint that grants trust.** `status` reports whether this checkout is
listed in `skills.trusted_project_dirs` and returns the exact command that fixes it, and
that is where it stops. Trusting a checkout makes every `SKILL.md` in it a procedure
hermes will follow in every session on the machine — the prompt-injection vector the
gate was built to close. Software that grants itself the trust has removed the gate.

**In the Kanban, an inbox rather than a list of paths.** `HermesLearningCard` used to
print the queue as thirty-four `skills/_proposed/…` paths with nothing to do with any of
them — reported, word for word, as *"je ne sais pas ce que je dois faire de tout ce
texte"*. It now draws a skill's path in four steps (hermes learned → filtered out on its
own → **to decide** → in the brain), says in one sentence what there is to do, and gives
each candidate its purpose, its hermes category, a preview of the procedure and two
answers, one at a time or for a selection:

| Answer | What happens (`learning_loop/hermes_review.py`) |
|---|---|
| **Keep** | the same `hermes_adopt.adopt` the loop runs, then a `knowledge/hermes/<skill>.md` note in the brain, linked to the task the person was looking at |
| **Turn down** | `hermes_adopt.decline` writes `decision: declined` to `ADOPTED.json` and removes the file; the ingest never mirrors, proposes or adopts that name again |

Only `hermes--<slug>.md` names the ingest wrote are accepted (`recorded_facts`): a name
from the request is matched against that pattern before it is joined to a path, and a
proposal from the learning loop's own gates is never decided here.

**The cycle is automatic.** It already ran at the end of every build (`observe`); the
panel adds a pass when it opens, at most once every fifteen minutes
(`hermes-store.autoCycle`). The refresh button is a shortcut, not the mechanism.

**Every kept skill feeds the brain** (`hermes/brain_link.py`) — kept by a person *or* by
auto-adoption. It is filed as **knowledge**, never as an instruction or a brain skill:
both of those are loaded by every connected agent, and a hermes skill carries no
evidence from a build and names hermes's tools. Knowledge is recalled on demand and read
as data, which is the standing an unverified procedure deserves. The card also reports
the other half of the loop: whether hermes has the `workpilot-brain` MCP server, i.e.
whether it reads back what the brain holds — and opens the brain settings when not.

It renders nothing when hermes is not installed: a permanent card reading "feature not in
use" is a card nobody reads. Like `workflows/api.py`, the router is refused in server
mode — every answer is about `$HERMES_HOME` on the machine running the backend, which on
a shared deployment belongs to the server and not to the tenant asking.

### Portability of a candidate

The cycle itself runs on any provider — every answer comes from files on disk, and
`TestProviderIndependence` fails the build if `hermes/` ever names `create_client`,
`anthropic` or `claude_agent_sdk`. What is *not* portable is the candidate's prose.

Hermes's authoring standard requires a skill to say `read_file` and not cat,
`search_files` and not grep, `patch` and not sed. That is right for hermes and wrong
everywhere else: `skills/<pack>/` is emitted to Claude Code, Copilot, Codex, Cursor and
Gemini alike, none of which have those tools. So each candidate carries a **Portability**
section naming the hermes tools it uses and their equivalents here, and the body is left
exactly as hermes wrote it — a find-and-replace would leave the surrounding sentence
("invoke through the `terminal` tool") describing a tool it no longer names. Adopting a
candidate is a rewrite, and the candidate says so rather than letting whoever runs the
adopted skill first discover it.

The same vocabulary is recorded in `capabilities/harnesses.yaml` under `hermes.tools`.
Nothing reads it today — `agents_path` is null, and `translate_tools` fires only when an
agent definition is emitted — but an empty map claimed "nothing to translate", which was
wrong in the one direction that matters: the day hermes gets an agents path, an empty map
emits Claude's names verbatim.

### `SOUL.md`

`SOUL.md` at the root of this repository is the persona WorkPilot offers, and it is
**not a project context file**. `agent/prompt_builder.load_soul_md` reads exactly one
path — `<HERMES_HOME>/SOUL.md` — and injects it as identity slot #1 of every hermes
session on every surface. Project context is a different chain entirely (`.hermes.md` /
`HERMES.md` → `AGENTS.md` → `CLAUDE.md` → `.cursorrules`, first found wins), and this
repository is already answered by its committed `AGENTS.md`.

Shipping one anyway is right for the reason hermes ships one at the root of its own
repository: it is the persona a person installs, and a persona nobody can see is a
persona nobody adopts. The file is the offer; the install is a separate, explicit act —
from the card's button or `--action install-soul`, never from a build. That home belongs
to the user's own agent, in conversations WorkPilot will never see; a pipeline that
silently overwrote it would be rewriting a personality that is not ours. A *different*
persona already in place is left alone unless the caller says otherwise, and the one it
replaces is kept beside it with a timestamp.

A candidate carries **no external verification signal**, and that is not a gap to close
later. Hermes's approval gate is a person saying yes to a text; it is not an observation
of a build that used the skill. Counting it as corroboration would manufacture exactly
the evidence `skill_proposer.evaluate` refuses to invent. Hermes proposes from breadth,
WorkPilot decides from evidence, and a person reads one diff. Nothing under
`skills/<pack>/` is modified, and nothing under `~/.hermes` is ever written.
