# Verification loop (verify)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Verification loop (verify)

A green test suite and a successful build do not prove a feature works. The
`verify` phase had pointed at `superpowers/verification-before-completion`, a
skill this repository never fetched, so it answered "could not run" on every
build — and even when it ran, it read one `Tests: pass|fail` line. **No phase
launched the application the task had just changed.** An API crashing at
startup, a page full of console errors, an endpoint answering 500: all reached
human review with QA's approval.

`apps/backend/verify/` is that loop, and the `/verify` skill
(`skills/tooling/verify/`) is its procedure. Launch the app, read every error,
fix and relaunch, drive the app to the state the task was meant to produce and
confirm it, trace performance through Chrome DevTools MCP, and keep a
screenshot or a score as proof.

| Target | Detected from | Driven to the change by | Proof |
|---|---|---|---|
| `web-frontend` | Vite, Next, Angular, Nuxt, SvelteKit, React/webpack, Remix, Gatsby, Solid, Qwik, Lit… (`AppEmulatorRunner`), Blazor WebAssembly, Leptos, Yew/Trunk, Dioxus, a static `index.html` | snapshot → click → fill, read back | screenshot (desktop + mobile viewport) + Lighthouse-curve score |
| `desktop` | `electron` in the dependencies | the same, through `--remote-debugging-port` | the same |
| `windows-app` | an executable `.csproj` with `UseWPF`, `UseWindowsForms` or the Windows App SDK | UI Automation in the one window the card names (`verify_window`) | a capture of that window alone |
| `mobile` | `mobile.stacks.detect_stack` | emulator / simulator (`mobile/launch.py`) | device frame + launch time |
| `backend-api` | ASP.NET Core, FastAPI/Flask/Django, Express/Nest, Spring, Go, PHP (Laravel, Symfony), Ruby (Rails, Rack), Rust (Axum, Actix, Rocket…) | the touched endpoints, called with payloads built from the OpenAPI schema | status + response validated against the schema + p50/p95 latency |

A project with no target (a library, a CLI) is `not-applicable` — neither a
pass nor a failure.

**A backend that renders pages is opened as well as called.** Blazor Server
and Blazor Web App, Razor Pages, MVC, Django or Flask templates, Express
views, Thymeleaf, Go templates, Rails views, Blade: the project is a
`backend-api`, and `verify/web_stacks.py` `serves_pages` finds the templates it
renders (`.razor`, `.cshtml`, `.erb`, `.blade.php`, `.ejs`, `.gohtml`…, or an
`.html` under `templates/`, `views/`, `wwwroot/`…; never under tests, docs or a
coverage report). Such a target has `pages: true`: its landing page goes
through the same browser pass as a front end (console and network errors fed
to the fixer, performance trace, desktop and mobile captures), and its
endpoints are still called. The verifier is told the target renders pages.

```
apps/backend/verify/
  detect.py     which targets, their launch command, port and readiness URL (a learned recipe first)
  target.py     Target, the thing to launch, and the file helpers detectors share
  web_stacks.py pages a backend renders; PHP, Ruby, Rust and static-site targets
  launch.py     own process group, a free port injected, readiness on loopback, the log captured
  errors.py     stack traces (docintel/stacktrace), build codes (foundation/ci_logs), console and network errors
  devtools.py   chrome-devtools-mcp driven from Python (MCPToolManager); Playwright fallback, same output
  perf.py       LCP / CLS / TBT / FCP -> Lighthouse log-normal score; latency stats
  endpoints.py  the running app's OpenAPI, filtered by docintel.api_tests.find_handler on the diff
  payloads.py   a minimal valid instance from a JSON Schema, and validation of a response against it
  window.py     a Windows app's one window: the card's name, the pin, the UI Automation helper (uia/driver.ps1)
  mobile.py     boot -> build -> install -> launch -> frame, captures filed for the visual review
  tools.py      THE verify_* tools, and their execution (VerifyToolbox)
  mcp_server.py the same tools over stdio MCP (runners/verify_mcp.py)
  loop.py       launch -> errors -> fixer, bounded by progress; then the verifier session; then evidence
  replay.py     the verify-replay phase: the recorded scenario and endpoints, without a model
  compare.py    the same replay on the base branch and on the task: what behaves differently
  scenario.py   the card's own scenario (verifyScenario): steps, verifier instructions, verdict
  walkthrough.py the scenario filmed (WebM, launch mode) and its step captures as a GIF for the PR
  record.py     <spec_dir>/verify/verify.json, report.md, events.jsonl; the computed status
  learn.py      launch recipe, perf baseline, brain note, gotchas
  api.py        GET /api/verify/, /screenshot, /trace, /walkthrough, /video; POST /api/verify/run, /compare
```

**Python does the deterministic half, for every provider.** Launching,
waiting, parsing logs, calling endpoints and tracing performance do not need a
model, so they do not depend on one: `devtools.py` opens its own MCP session to
`chrome-devtools-mcp`, which is why the trace "via Chrome DevTools MCP" runs
under Ollama or Copilot too — the model never has to know how to call MCP. The
model is asked only for what needs judgement: fixing the error, and finding the
clicks or the payload that reach the changed state.

**One tool list, two transports.** `verify/tools.py` defines `verify_detect`,
`verify_launch`, `verify_logs`, `verify_stop`, `verify_browser` (one tool, an
`action` enum — a short list is what a small local model can use),
`verify_screenshot`, `verify_perf_trace`, `verify_endpoints`,
`verify_call_endpoint`, `verify_device`, `verify_window` and `verify_record`. Non-Claude
providers execute them in process through `tool_executor` (the `verifier`
agent type); the Claude SDK gets the `workpilot-verify` stdio server from
`create_client`, beside `chrome-devtools`. Every step a tool takes is appended
to the record, so the evidence does not depend on the model remembering to
report it.

**A general skill, specialised per provider.** `skills_registry/overlays.py`
is the generic mechanism, and `/verify` its first user. The chain is base
`SKILL.md` → family overlay (`providers/_sdk.md` for the Claude SDK family,
`providers/_executor.md` for providers driven by `ToolExecutor`, decided by
`adapter` / `degrades_to` in `capabilities/providers.yaml`) → provider overlay
(`ollama.md`, `copilot.md`). Merging is per section: an overlay `## Heading`
replaces the base section of that name, a new heading is appended, and
`<!-- append -->` extends instead of replacing. `workflows/runner.find_skill_body`
and the Kanban command bar resolve it for the phase's provider; external
harnesses get `providers/` next to the emitted `SKILL.md` and are told to read
their file.

**A Windows app is driven through UI Automation, in one window.** WPF,
WinForms and WinUI apps have no URL and no DevTools port: `verify/window.py`
drives them through the accessibility tree Windows keeps for every window.

- *Which window.* The card names it (`verifyWindow` in `task_metadata.json`, a
  part of its title, set in the card's form under the verification loop). The
  window must belong to the process tree the verification launched; without a
  name, it is that tree's first main window. Launch waits for it ("ready" is
  the window showing, not a port) and pins it in `state.json`. Every later
  request re-checks the pin against the tree; the dialogs the window owns
  (a message box) count as part of it. A model never names a window, a process
  or a handle, only an element of the last snapshot (`e12`). When the pinned
  window closes while the app runs (a splash screen, a login window), the app's
  next window under the same rule replaces it. Nothing else on the desktop is
  listed, read, captured or touched.
- *How.* Elements are acted on through their patterns (Invoke, Value, Toggle,
  SelectionItem, ExpandCollapse), never with synthetic mouse or keyboard
  input: the person's own input is never taken over, and the window does not
  need the foreground. An element without a pattern cannot be driven, and the
  tool says so. A capture is the window printed alone (`PrintWindow`), never a
  copy of the screen; a capture that comes back one colour is refused as
  evidence.
- *The helper.* `verify/uia/driver.ps1` runs in Windows PowerShell 5.1, present
  on every Windows, so no dependency is added. It compiles its C# once per
  session and answers one JSON line per request; a request that hangs (an app
  that does not answer) kills it, and the next request starts a fresh one. Its
  environment is built (Windows' own directories, no credential). Element names
  and values go through `docintel.redact`, and one that reads like an
  injection is withheld.
- *Elsewhere.* Off Windows, or when PowerShell cannot run the helper, the step
  is an environment limit: the record says "unknown", never "fail". A
  packaged (MSIX) WinUI app is detected but not launched, because `dotnet run`
  cannot start it; the target says how to make it launchable.
- *After QA.* Window steps (`window_click`, `window_fill`…) are replayed like
  browser steps: the element is found again by its AutomationId, else by its
  type and name.

**A web change can be verified by the card's own scenario.** Plan of 29
October, IA8, the web counterpart of the Windows window above. Without it the
verifier picks its own clicks to reach the changed state; with it, the person
says which steps prove the change.

- *Where it is written.* `verifyScenario` in `task_metadata.json`, set in the
  card's form under the verification loop: plain language, one step per line
  (`1.`, `-`, `[ ]` markers are dropped). `verify/scenario.py` reads it,
  bounded (20 steps of 300 characters), control characters removed.
- *How it is followed.* The verifier's prompt lists the steps and asks, after
  each, for a capture (`verify_screenshot`) and a report
  (`verify_record kind=scenario_step`, `step`, `outcome` pass | fail |
  blocked, `note`). The step number and the outcome are checked against the
  card's scenario and a closed list; a capture is kept only if this
  verification took it, under its own `screenshots/`. The steps say what to
  check, never what the tools may do: URLs stay on the launched app.
- *Playwright, and its trace.* A card with a scenario puts Playwright first
  (`VERIFY_BROWSER=auto`), with its trace recording captures and DOM
  snapshots per action. The trace is written when the verifier records its
  verdict (the session may be stopped without a goodbye), else when the
  browser closes, as `verify/scenario-trace.zip`. Only the toolbox through
  which steps were reported keeps it: on the Claude path the verifier drives
  the `workpilot-verify` server's browser, and the loop's own browser (launch
  errors, evidence) drops its trace instead of overwriting that one. Chrome
  DevTools MCP has no such trace: when only it can start, the record says
  there is none.
- *The walkthrough (F5).* The trace needs a download and a viewer; two files
  are readable in seconds. `verify/scenario-video.webm` is Playwright's
  recording of the scenario's page (`record_video_dir`), written when the
  trace is: the page is closed so the video lands, and a fresh page of the
  same context carries the evidence after it. Attached over CDP to a running
  desktop app, the session reuses a context it did not create, which films
  nothing: the record says so (`video_note`) rather than show an empty
  player. Playwright films with its own ffmpeg; one missing costs the video,
  never the session. Over 25 MB the video is dropped. The same toolbox rule as
  the trace decides which browser's video stands.
  `verify/scenario-walkthrough.gif` is made with Pillow from the captures
  reported with the steps, in step order (the last report of a step wins),
  960 px wide: a GIF shows inline in a GitHub comment, a video does not. Over
  6 MB it keeps the first and the last frame. The *Verification* tab plays
  the video and shows the GIF; the PR dialog attaches the GIF to the visual
  proof only when the person ticks it, after reading that every reader of the
  repository will see it (the app it films is served on loopback with
  whatever data it holds). It is copied into the visual proof's run folder
  and pushed with the captures, under a *Walkthrough* section.
- *The verdict.* A failed step fails the verification. A scenario not carried
  out in full (a step blocked or never reported, no verifier session at effort
  `low`) cannot pass: it is `unknown`, with the count of steps that passed.
  When a step is reported twice, the last report stands.
- *Where it shows.* `report.md` and QA's `verify_section` list each step with
  its outcome; the *Verification* tab shows each step with its note and
  capture, and a link to the trace (`GET /api/verify/trace`, the one the
  record names, inside the spec, opened by the OS browser), to open at
  trace.playwright.dev or with `npx playwright show-trace`.

**The loop is bounded by progress, not by a round count.** Errors after a
launch are written to `VERIFY_FIX_REQUEST.md` and handed to a fixer session on
the same provider; the app is relaunched. Two rounds without fewer errors and
the loop stops and says what blocks — the same rule as `archify.authoring`.
`VERIFY_MAX_ROUNDS` is a ceiling on top of it. An environment error (database
absent, variable missing, port taken) is classified as such: a lesson for the
next run, not a defect of the code.

**Where it sits.** `verify` runs between `review` and `qa`, so QA judges code
that was seen running and receives the record (`verify_section`, fenced as
data; a measured failure is at least a HIGH finding). It declares
`hard_gate: tests-pass,app-verified` — `hard_gates.py` reads a comma list now —
and `app-verified` is unknown, not failed, when nothing was verifiable. At
effort `low` only the deterministic half runs. `verify-replay` is a
deterministic phase after QA: when QA changed the working tree since the
verification, it replays the recorded endpoints and scenario without a model,
and turns a pass into "regressed after QA" when they no longer hold; an
unchanged fingerprint costs nothing.

**Compared with the base branch (prospective P8).** A reviewer wants to know
what the change *does*, not only that it works. *Compare with the base branch*
in the *Verification* tab (`POST /api/verify/compare`, `agent.execute` in
server mode; `verify_runner.py --action compare`) replays the recorded scenario
and endpoint calls twice, without a model: on the branch's merge base, checked
out apart in `.workpilot/verify-base/<spec>` and prepared by the same worktree
recipe as the task (dependencies linked, its own port block), then on the task.
The sides run one after the other, each with a spec folder of its own, so the
verification's trace and video stay untouched. `compare.py` lists what differs:
a step or confirmed state that works on one side only (*broken by the task*
first, then *works thanks to the task*), console errors and warnings that
appear or disappear, network requests and endpoint calls that appear, vanish
or answer another status, and the page at the end of the scenario on each side.
What two launches of the same code print differently is dropped first: a
loopback origin and its port, the query string, a bundler's content hash, a
line and column; a pending request is never compared. The comparison is
evidence, never a gate: it does not change the record's status. Each side
starts from its own data, which the panel says. The checkout's dependency
links are removed before the checkout is deleted, so deleting it never walks
into the project's folders.

**It never decides alone that a build failed.** A missing Chrome, no `npx`, no
OpenAPI document: the step is recorded `unknown` with its reason, and a metric
that was not measured is `null`, never `0` — renormalised out of the score the
way the Bounty Board does. The verdict reaches the build through the gate and
through QA.

**Guardrails.** Calls go to loopback only, without a proxy, and only to the app
this verification launched; mutating methods can be switched off
(`VERIFY_ALLOW_MUTATIONS`). A launch command proposed by a model must be a
project launcher with no shell metacharacter. Response bodies go through
`docintel.redact` and `injection_guard` before they are written or shown to a
model. Every launched process group is killed in a `finally`.

**What it teaches.** A launch that worked becomes
`.workpilot/verify/recipe.json` (the command, port, readiness URL and the
*names* of the variables it needed — never their values), so the next task
launches first time. Performance per route goes into
`.workpilot/verify/baseline.json`, and a drop beyond `VERIFY_PERF_REGRESSION`
points is a medium finding. A launch failure that was fixed becomes a gotcha in
project memory, the build gets a `verify` note in the shared brain, and
`observe` counts a measured pass as the external signal `runtime_verified`.

**Everywhere else.** The Kanban shows `VerifyLoopCard` in the task overview, a
*Verification* tab when a record exists (rounds, screenshots, metrics,
endpoints) and a badge on the card (`implementation_plan.json` →
`verification`). A task can switch the loop on or off (`verifyLoop` →
`WORKPILOT_VERIFY_LOOP`), and the project setting turns it off for every task
(`VERIFY_ENABLED=false`). `run.py --spec 001 --verify` and
`runners/verify_runner.py --action detect|run|replay|status` run it from a
shell; the self-healing pipeline verifies a fix before proposing its PR; the
Bounty Board scores each contestant's `runtime` evidence. Other agents get the
same tools over MCP:

```bash
claude mcp add workpilot-verify -- python apps/backend/runners/verify_mcp.py --project-dir .
```

| Variable | Default | What it does |
|---|---|---|
| `VERIFY_ENABLED` | `true` | The master switch (the project setting writes `false`) |
| `WORKPILOT_VERIFY_LOOP` | — | Per-task override, `true` / `false`, sent by the Kanban |
| `VERIFY_MAX_ROUNDS` | `5` | Ceiling on fix rounds, on top of the progress rule |
| `VERIFY_LAUNCH_TIMEOUT` | `120` | Seconds to wait for the app to answer |
| `VERIFY_PERF_TRACE` | `true` | Performance trace and Lighthouse audit |
| `VERIFY_ALLOW_MUTATIONS` | `true` | Call POST/PUT/PATCH/DELETE endpoints on the launched dev server |
| `VERIFY_PERF_REGRESSION` | `10` | Score drop, in points, reported as a regression |
| `VERIFY_BROWSER` | `auto` | `auto`, `devtools`, `playwright` or `off` |
| `VERIFY_CHROME_PATH` | — | A specific Chrome / Chromium binary |

Read from `.workpilot/.env` as well as the environment; real variables win.
