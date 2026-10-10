# UI/UX design intelligence (ui-ux-pro-max)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## UI/UX design intelligence (ui-ux-pro-max)

[ui-ux-pro-max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill)
(nextlevelbuilder, MIT), **Basic edition**, is a skill plus a dataset: styles,
palettes, font pairings, 119 UX guidelines and the rules of 22 UI stacks —
React, Next.js, Vue, Svelte, Angular, Laravel, SwiftUI, Compose, Flutter, and
on the .NET side WPF, WinUI, UWP, Avalonia and Uno — searched by a BM25 engine
written against the Python standard library. No network, no model, no token:
it answers "which design system for this product, and which rules for this
stack" in about a hundred milliseconds.

It is wired in as **data the agents receive**, not as one more agent, and only
on the tasks that touch an interface.

```
skills/ui-ux-pro-max/            the vendored skill (scripts/vendor_ui_ux_pro_max.py, VENDOR.json)
apps/backend/uiux/
  surface.py     the one answer to "is this file part of an interface?"
  stack.py       which UI toolkits the project uses, and which upstream guide fits
  relevance.py   does this task touch the interface? override -> plan -> description
  runtime.py     where the vendored skill is; the doctor
  engine.py      runs search.py with the backend's own interpreter, arguments checked
  preflight.py   the project's MASTER.md, else a generated one written into the worktree
  prompt.py      the section the coder, QA and the skill phases read
  mcp_server.py  workpilot-uiux: the same engine as read-only MCP tools
  integration.py the server and tools, offered only to a UI task's agents
  knowledge.py   the merged design system, filed in the shared brain
  api.py         GET /api/uiux/task, POST /api/uiux/override
```

**Vendored, and the one path that did not travel is rewritten.** Upstream runs
its engine as `python "${CLAUDE_PLUGIN_ROOT}/.claude/skills/ui-ux-pro-max/scripts/search.py"`
— a path that exists in a Claude Code plugin and nowhere else: not in
`.agents/skills/` (Codex, Gemini CLI, hermes, OpenCode, Antigravity, whose
installer writes to that same directory), not under `.github/skills/`
(Copilot), not in a WorkPilot build. `scripts/vendor_ui_ux_pro_max.py` pins a
tag, takes upstream's skill directory minus what nothing reads at run time
(its test suite, its dataset validator, 1.2 MB of source JSON), makes that
path `"<skill-dir>/scripts/search.py"`, and puts a **Portability** section in
front of the body: `<skill-dir>` per harness, `py -3` on Windows, hermes's tool
names, and that a WorkPilot build has the engine as tools. A path it does not
know how to rewrite fails the vendoring. Committed rather than fetched on
demand, for archify's reason: the pipeline reads it, and the packaged app gets
it through `extraResources` (`skills_registry.bundled`) with no command to run.

**A subprocess, with `sys.executable`.** Upstream's modules are named `core` and
`design_system`; imported into the backend, `from core import …` would resolve
WorkPilot's own `core`. So the engine runs as a child process of the one Python
guaranteed to exist on the machine — `python3` is usually absent on Windows —
with `-E -s -B`, and every argument checked against upstream's choices before
the process starts: a model-supplied domain or stack can never become an
option of `search.py`.

**Relevance is decided once, from files, and a backend task pays nothing.**

| Tier | Signal | Why |
|---|---|---|
| 1 | `<spec_dir>/uiux/override.json` | the Kanban card's "skip for this task" / "decide automatically" |
| 2 | the plan's `files_to_modify` / `files_to_create` on `uiux.surface` | the strongest evidence before code exists; a plan naming only backend files is a backend task whatever its description says |
| 3 | FR/EN words of the description — **only on a project with a UI toolkit** | before a plan exists; "page" in a Web API task is pagination |

A task judged not-UI gets no prompt section, no MCP server, no tool definition
(tool definitions are context a model reads on every turn), and no card.

**A phase between planning and coding, with no session.** `ui-design-system`
is declared in `workflow.yaml` after `analyze` and before `mobile-design`,
with `when: *ui_surface` — the anchor holds exactly
`uiux.surface.UI_GLOBS`, and `tests/test_uiux.py` keeps the two equal. It is in
`DETERMINISTIC_PHASES` (never pruned: it saves nothing to drop it) and in the
runner's `DETERMINISTIC_EXECUTORS`, so `run_skill_phase` calls
`uiux.preflight.run_preflight` instead of opening a session.

**The plan narrows the window — for every conditional phase.** The profile a
build starts with is resolved before planning, with no change set, and
`_touched` answers "unknown — run": `mobile-design` (and the `frontend-design`
phase the workflow declared then) used to run on every backend task at medium
effort. Once the plan validates,
`agents/coder.py` narrows the profile to the plan's files
(`workflows.forecast.planned_files`, `engine.narrow_to_forecast`) before
running the planning→coding window. It only ever removes, and no forecast
keeps the profile as it was; the post-coding resolution still reads the real
diff. `_touched` also matches a root file now: `fnmatch("App.tsx", "**/*.tsx")`
is False, so a root `App.tsx` or `index.html` skipped every frontend phase.

**One design system per project, not one per task.** The preflight reads
`design-system/<project>/MASTER.md` (upstream's own convention) when the
project has one — never rewritten, and scanned by `injection_guard` like an
attachment, since somebody else may have written it. Otherwise it generates one
from the task's description and, unless `UIUX_PERSIST_MASTER=false`, writes it
into the worktree with upstream's `--persist` and never `--force`: it lands in
the task's diff, a person reviews it, and once merged the next UI task reads it
instead of inventing another palette. The stack guidelines of the toolkit the
task's UI files belong to are added (a monorepo's `apps/admin/` gets the admin
app's guide). Blazor and .NET MAUI have no upstream guide and get none rather
than the nearest wrong one. Nothing here fails a build: every absence is a
recorded reason.

**Who reads it.**

| Reader | What |
|---|---|
| coder | `uiux_section(spec_dir, subtask)` — only on subtasks whose declared files are UI; a full-stack task pays for it on its front end only |
| skill phases | `mobile-design` designs against it rather than beside it; `review` holds the diff to it |
| QA reviewer | the design system plus upstream's canonical pre-delivery checklist |
| any agent of a UI task | `uiux_search`, `uiux_stack_guidelines`, `uiux_design_system`, `uiux_project_design_system` — over MCP for Claude (`get_required_mcp_servers` adds `uiux`, `AGENT_MCP_<agent>_REMOVE=uiux` removes it), in-process in `tool_executor` for Copilot, OpenAI/Codex, Gemini, Ollama… |

The tools are why there is a server at all: on a React or .NET project the Bash
allowlist has no `python`, and widening it for one skill would widen it for
everything. The sections are bounded (design system, guidelines, checklist cut
at fixed sizes) because local models read them too.

**Memories and the other harnesses.** At merge, `uiux.knowledge` files the
project's `MASTER.md` in the shared brain under
`knowledge/projects/<p>/uiux/` — knowledge, never an instruction, rewritten
only when it changed, nothing without a brain — so Claude Code, Codex or hermes
connected to the brain recall the palette without opening the repository. The
emitted skill in `.agents/skills/` is what Codex, Gemini CLI, hermes, OpenCode
and Antigravity load, and what the Kanban command bar serves to every provider;
`hermes_triage` counts it as already provided. For Claude Code on a project of
your own: `claude mcp add workpilot-uiux -- python <WorkPilot>/apps/backend/runners/uiux_mcp.py --project-dir .`.

**In the UI.** `UiUxDesignCard`, in the task panel's *Execution plan* section:
why the task is UI, which design system (the project's or a generated one, with
its path in the diff), the main swatches, fonts and style, and a button to set
the task aside or back. It renders nothing on a backend task. There is no
"generate now": the design system is written into a worktree a person reviews,
and the panel has none. Settings → Agent Tools carries the two switches.

| Variable | Default | What it does |
|---|---|---|
| `UIUX_ENABLED` | `true` | The master switch. On costs nothing on a backend task |
| `UIUX_PERSIST_MASTER` | `true` | Write `design-system/<project>/MASTER.md` into the worktree when the project has none |
| `UIUX_MAX_GUIDELINES` | `5` | Stack guidelines given to the coder; a nonsense value falls back to the default |
| `WORKPILOT_UIUX_HOME` | — | A clone of the skill, for moving the pin without touching `skills/` |

Read from `.workpilot/.env` as well as the environment; real variables win.
