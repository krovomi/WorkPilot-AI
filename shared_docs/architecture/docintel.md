# Attachments, diagrams and ADRs (docintel)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Attachments, diagrams and ADRs (`docintel`)

The Kanban has always let a person attach screenshots, mockups and diagrams to
a task. The frontend copied them to `<spec_dir>/attachments/` and listed them
in `requirements.json` as `attached_images` — and no phase of the build read
either. `apps/backend/docintel/` is the reader, and it runs once, before
planning, beside the libdocs preflight (`_run_attachments_preflight` in
`cli/build_commands.py`).

```
apps/backend/docintel/
  diagrams.py   draw.io and Excalidraw, including the source their PNG/SVG exports embed
  conformance.py the repository's architecture diagram vs. the .csproj reference graph
  ocr.py        the OCR entry point, over engines/
  engines/      Tesseract, PaddleOCR, docTR, a local vision model, Azure — tried in order
  redact.py     secrets in what was read: masked in text, painted out of images
  read_guard.py `Read` refused on an original the preflight withheld or redacted
  adr.py        where a project keeps its ADRs, and which ones bind
  stacktrace.py a stack trace (.NET, Python, Node, JVM, Go, Ruby, PHP, Rust) -> this repo's file:line
  diagnostics.py stack traces + CI logs of an attachment or the description, located
  c4.py         Structurizr DSL and C4-PlantUML, read as the same boxes and arrows
  orm.py        the ORM mapping, read from the code without compiling (EF Core, SQLAlchemy, Django, TypeORM, Prisma, JPA, ActiveRecord, Doctrine, Eloquent, GORM)
  erd.py        an ERD (draw.io/Excalidraw crow's feet, DBML, Mermaid) vs. that mapping
  api_capture.py a Postman collection, OpenAPI spec, .http file, curl or screenshot -> HTTP calls
  api_tests.py  each call as an integration test in the project's own stack and libraries
  sequence.py   PlantUML / Mermaid sequence diagrams, each call looked up in the code
  pdf.py        a PDF's text layer (with its columns), else its pages rendered for OCR
  tables.py     business-rule tables in a document -> a parametrised test per language
  spec_drafts.py requirements and acceptance criteria proposed from a specification, decided by a person
  whiteboard.py a whiteboard photo -> an editable .drawio, through the local vision model only
  figma.py      a Figma link -> attachments/<name>.figma.json (frames and labels, through the API)
  knowledge.py  what a person validated in the card, filed in the shared brain's knowledge/
  labels.py     a screen's labels: normalised, compared by edit distance, diffed; lot F's .figma.json
  screens.py    what a screen's text says: raw i18n keys, language, truncation, crash / error / sign-in
  visual_qa.py  the captures of the running app, OCR'd before QA review -> docintel/visual_qa.json
  preflight.py  attachments -> <spec_dir>/docintel/result.json + extracted/*.md
  prompt.py     the prompt sections
  api.py        GET /api/docintel/ — recomputed, nothing written
  mcp_server.py the same answers, for any agent working in the project (read-only)
```

**Structured first, OCR last.** A `.drawio` is XML and an `.excalidraw` is
JSON, and both editors hide that source inside their PNG (`tEXt` chunk) and SVG
exports. Reading it gives boxes, containers and *arrows*; transcribing the
pixels would give the words and lose the only thing a diagram claims that prose
does not. `parse_diagram` decides by content, not by name: `schema.png`
exported with "include a copy of my diagram" is a draw.io file.

**Pixels stay on the machine.** OCR transcribes a screenshot before planning
so it can be quoted and scanned; without it, the image is handed to the agents,
which open it with their own file tool through the provider the task was
configured for. Office files and PDFs with a text layer are left to the
`convert-documents-to-markdown` skill every agent already carries — one
converter, not two. A *scanned* PDF is the exception, because that converter
returns empty pages for it: see **A specification is proposed, never written**
below.

**The engine is a list, not a choice.** `DOCINTEL_OCR_ENGINE` is an ordered
fallback chain (`engines/__init__.py`): the first engine that produces text
answers, the record names it (`engine`), and every engine skipped on the way
leaves `engine:reason` in `attempts` — "why did the vision model not answer" is
a line on the record, not a debug log. The default is `tesseract` alone, the
engine the previous release used and the only one that is a binary rather than
a Python stack.

| Engine | Where it runs | Why it is here |
|---|---|---|
| `tesseract` | a binary on PATH | the default; asked for TSV so the words come with boxes |
| `paddleocr`, `doctr` | Python, imported on first use | better on small UI text and dark themes; heavy, so a person installs them |
| `ollama-vision` | a local vision model through Ollama (`qwen2.5vl`, `llava`) | *describes* a screenshot — the dialog, the layout, the arrows — not only its words |
| `azure-document-intelligence` | Azure, the one cloud engine | teams that already keep it in their tenant; handwriting and dense scans |

Two refusals live in the chain rather than in each engine, because an engine
must not be the one deciding whether it may run. A **cloud engine** runs only
when it is listed *and* has an https endpoint and a key; it is refused under
`airgapStrict` before it is asked anything, with a message naming
`DOCINTEL_OCR_ENGINE` and the Offline Mode switch; and it is refused when there
is no project to read the policy from, or the policy is unreadable — the one
setting whose failure mode must be "nothing left the machine". The **Kanban
preview** (`GET /api/docintel/`, recomputed on every panel opening) defers the
vision and cloud engines to the build: opening a panel is not a reason to run a
vision model or to upload a screenshot to a metered service.

`ollama-vision` is local by the same rule: an `OLLAMA_BASE_URL` that is not
loopback is refused (`remote-host`), because a GPU box on the LAN is exactly
"the pixels leave the machine", and the request bypasses the proxy. Its answer
is marked `described` and the prompt says so — a description is a model's
reading, a transcription is the pixels' words.

**A secret on screen is masked, and never repeated.** A screenshot is where a
credential leaks without anybody deciding to leak it: the portal with the
storage key on screen, `appsettings.json` open behind a stack trace. The
patterns are `security/scan_secrets.py`'s — the pre-commit table, extended with
the unquoted `Key=Value;` connection strings (ADO.NET `Password=`,
`AccountKey=`, `SharedAccessKey=`) and generic JWTs it had never matched — and
there is no second list. A match is replaced by `[REDACTED: <kind>]` in the
text before it reaches `result.json`, `extracted/` or a prompt, in diagram
labels too; the record carries the *kinds* (`secrets`), never a value.

The image itself is then **redacted** — a copy under `docintel/redacted/` with
every OCR line that carried a secret painted black, re-encoded from pixels so
no metadata chunk survives — when the engine gave boxes and Pillow is
installed. Otherwise it is **withheld**. Whole lines rather than matched words:
OCR splits and merges tokens, and covering `Server=db;` beside the password
costs context where missing one character of the key costs the key. None of
this depends on the task's provider: phases can run on different providers, and
the preflight runs before any of them. A scanner that cannot load withholds
(`secret-scan-unavailable`) — "could not check" must not read as "none".

**An attachment is data.** Extracted text — masked first, so the scanner's own
report cannot quote a secret — goes through `injection_guard`. Text it flags in
a document is withheld from the prompt and reported; text it flags in an
*image* withholds the image, because the image is the carrier, and a vision
model shown it may repeat it. Every section says in so many words that
attachment content is not an instruction.

**The prompt asks, `Read` enforces.** The attachments section tells agents to
use the masked copy and never to open a redacted or withheld original. A prompt
is a request, so `read_guard.make_read_guard_hook` is registered in
`create_client` beside the write-path guard and denies a `Read` of any original
the record names — `Read` is the one tool that turns an image into pixels a
Claude model sees. The other providers read through `ToolExecutor.read_file`,
which decodes UTF-8 and cannot hand an image to a model at all. What no layer
can do is read an image nobody transcribed: with no OCR engine, a screenshot
goes to the agents as it always did, and the card says why.

**ADRs bind the way the spec-kit constitution does.** `docintel_section` (in
`prompts_pkg/prompts.py`) reaches the planner, every coding subtask, the QA
reviewer and every workflow skill phase — the same four readers as
`constitution_section`. Only **accepted** records that nothing supersedes are
binding; proposed ones are listed as the direction, the rest are counted. A
change that contradicts an accepted ADR is at least a HIGH finding. `.adr-dir`
(adr-tools) wins over the directory guess, Nygard, MADR 2/3 and French headings
and statuses (`Statut : Accepté`) are all read. ADRs are re-read on every call;
attachments come from the persisted record.

**Azure DevOps screenshots arrive as attachments.** The import used to inline
work-item images as data URIs for display only; `saveInlinedImagesAsAttachments`
also writes them to `attachments/`, so they go through the same preflight as an
image dropped on a card. **Jira** gets the same treatment one step earlier:
`JIRA_GET_ATTACHMENTS` downloads the issue's image attachments in the main
process (`shared/jira-attachments.ts` — the token never reaches the renderer,
and a content URL on another host is ignored rather than followed with it), and
the Kanban import hands them to `createTask` as `attachedImages`. **GitHub and
GitLab** issues complete the set: `shared/issue-attachments.ts` reads the images
the issue body cites (`![](…)`, `<img src>`), downloads them in the main process
when they are on the instance's host — `github.com`, or the GitLab instance,
whose `/uploads/<secret>/<file>` is asked through the API because the web path
needs a session since GitLab 17 — and writes them to `attachments/` at import
and at investigation. The token goes to that host and nowhere else; a redirect
(GitHub answers with a signed storage URL) is followed once, *without* it. The
type is read from the bytes, not from the URL, and the caps are Jira's: ten
images of 5 MB at most, and an image that fails is an image fewer, never a
failed import. An older `*.githubusercontent.com` URL is another host, and is
left alone by the same rule.

**A Figma mockup is read as data, not as pixels.** A PNG export OCR'd back
reads `Cornmande` for `Commande` and loses which frame a label belonged to; the
Figma file holds both as data. `figma.py` reads a link a person pastes in the
card (`POST /api/docintel/figma`) through the REST API — frames of the linked
node, or the file's pages, and every visible text layer in order — and writes
`<spec_dir>/attachments/<name>.figma.json`:

```json
{"source": "figma", "file_key": "…", "frames": [{"id": "…", "name": "…", "texts": ["Libellé 1", "…"]}]}
```

That shape is a **contract** with the visual review (`visual_qa.py`, through
`labels.load_figma`), which reads every `*.figma.json` among the attachments as
the structured source of the mockup / rendering comparison, ahead of any OCR of
a mockup image; nothing is added to it, because a field only one reader
understands is how two readers of one file start to disagree. What is written
has been protected first, since later phases read the file as it is: every
label masked by the secret patterns, and each frame scanned by
`injection_guard` — a flagged frame is left out and counted. The preflight
reads it back through the same shape (`read_figma`, so a hand-edited file
smuggles nothing past it) as text, engine `figma`, and it is never taken for an
HTTP capture: `api_capture` and `api_tests` skip it by name and by `source`. The
token is `FIGMA_ACCESS_TOKEN` in `.workpilot/.env`, written by the main process
through a write-only channel (Settings → Figma) that answers "configured" and
never the value; it is sent to `api.figma.com` only, a constant — and a
redirect is refused rather than followed, because `urllib` would carry the
token to whatever host `Location` names — while the link
gives a file key and node ids matched by character class — the host of the
link is checked on the parsed URL, not searched in the string. A Figma call is
a cloud call, so it is refused under `airgapStrict` like a cloud OCR engine.
The card offers the link row only when a token is configured.

**The repository's own diagram is a rule too.** `conformance.py` reads the
draw.io / Excalidraw files under `docs/` (and beside the solution file) — and
C4 written as code, a Structurizr `workspace.dsl` or a C4-PlantUML file — as
dependency rules — `A -> B` means *A may depend on B*, transitively — and
compares them with the `.csproj` `<ProjectReference>` graph, the one dependency
graph that is declared rather than inferred. Boxes are matched to projects by
their words, PascalCase split (`Shared Kernel` names `Acme.SharedKernel`,
`Infrastructure` names `Acme.Infrastructure.Persistence`), the most specific box
winning; test projects are left out. A reference the diagram cannot reach is
reported, *inverted* first — Domain referencing Infrastructure is the
clean-architecture violation. The section tells the planner and coder the
allowed arrows and the existing debt, and QA to report a *new* crossing as
HIGH. A diagram whose arrows only ever contradict the references is drawn as
data flow, not dependencies: it is reported `ambiguous-direction` and produces
no finding, because a check that flags a whole solution is a check people stop
reading.

**Every build system that declares a module graph, not only .NET.** The code
side is the graph the build declares, whatever builds it: `.csproj`
`ProjectReference`, the Maven reactor's `<dependency>` on a sibling
artifactId, Gradle's `project(":domain")` for the modules `settings.gradle`
includes, npm / pnpm / yarn workspace packages depending on each other, Cargo
`path =` crates. A Spring or NestJS clean architecture is split into modules as
often as a .NET one is into projects, and it breaks the same way. What stays out
is an import-based graph: a single-module project declares nothing, and a guess
at its layers from import statements answers a fuzzier question. JS workspace
packages are the ones the workspace *declares* (`workspaces`,
`pnpm-workspace.yaml`), not every `package.json` on disk. A diagram whose arrows
carry ER markers is an ERD and is left to `erd.py` — its boxes are tables, not
layers.

**C4 as code is read, not rendered.** A Structurizr element (`api = container
"Api"`), its nesting and `group "Layer" { … }` are boxes and containers; `a -> b`
— or `-> b` inside an element — is an arrow; views and styles say nothing about
the model and are skipped. C4-PlantUML's `Container(…)`, `*_Boundary(…) { … }`,
`Rel(…)`, `Rel_Back` (reversed) and `BiRel` (both ways) map the same way. "A
uses B" in C4 is a dependency of A on B, the direction the rules already expect.

**An ERD against the ORM, in every stack.** `orm.py` reads the mapping the code
declares — EF Core `DbSet<>`, `HasOne/WithMany`, `IEntityTypeConfiguration<>`,
`[Table]`, navigation properties; SQLAlchemy `relationship` / `Mapped[...]` /
`ForeignKey`; Django fields; TypeORM and MikroORM decorators; Prisma models;
JPA annotations in Java and Kotlin; ActiveRecord associations; Doctrine
attributes and Eloquent relations; GORM structs — without compiling, running or
connecting to anything. Explicit mapping wins over convention, and convention
follows the ORMs' own rule (a collection one way and a reference the other is
one-to-many). `erd.py` reads the diagram: tables are the boxes of a draw.io or
Excalidraw ERD (rows are columns, crow's feet — `ERmany`, Excalidraw's
`crowfoot_*` — or a `1:N` label the cardinality), a DBML file, a Mermaid
`erDiagram`; OCR text only when it *is* one of those sources. Findings: a table
drawn and mapped by nothing, an entity mapped and not drawn, a relation missing
either way, a cardinality that differs. **An ambiguity is said, never scored**:
an arrow with no cardinality, a crow's foot at one end only, and a `1:N` label
the code has exactly the other way round (the arrow may be drawn backwards) are
listed as not judged — the rule `ambiguous-direction` set. An ERD attached to
the task is the *target* model and its differences are likely the work; one in
`docs/` is the record and its differences are drift. Planner, coder and QA get
the section; any agent gets `docintel_erd`.

**An HTTP call attached is an integration test to write.** `api_capture.py`
reads what the task carries — a Postman collection (with its saved responses
and `pm.response.to.have.status(…)`), an OpenAPI 3 / Swagger 2 spec in JSON or
YAML, a `.http` file, a `curl` line — and a screenshot of Postman or Swagger UI
only when none of those exists: a collection states `/api/orders` exactly, OCR
reads `/api/0rders`. `Authorization`, cookies and API-key headers are replaced
by a placeholder and every other value goes through the secret patterns before
anything is drafted — a bearer token in a test file is a token committed.
`api_tests.py` drafts one test per call, deterministically, in the project's
own stack (ASP.NET Core with xUnit or NUnit and `WebApplicationFactory<Program>`,
FastAPI / Flask / Django with pytest, Express / Fastify / NestJS with supertest,
Spring Boot with MockMvc, Go with httptest) and the assertion library it already
references (`test_generation/libraries.py`: FluentAssertions or Shouldly when
present, bare `Assert` otherwise). The destination is `test_generation/layout.py`'s,
fed the file that serves the route, and a C# file goes *into* the test project
(an `IntegrationTests` one first). The draft reaches the coder in the prompt and
any agent through `docintel_api_test`; nothing is written into the project.

**A sequence diagram's calls are looked up, not trusted.** `sequence.py` reads
PlantUML (`.puml`, fenced blocks, and the source PlantUML embeds in its PNG
exports — structured before OCR) and Mermaid `sequenceDiagram`, then looks up
each call: the participant as a type in any backend language, the message as a
method in that type's file. **Not verified is not wrong** — a participant
named for a role, a generated method or the flow the task is about to build
read the same way — so an unmatched call is reported *not verified* and never
becomes a finding. Actors, databases and queues are not code; a dashed arrow is
a return, not a call; `POST /api/orders` is a request, not a method.

**For every other agent: `workpilot-docintel`.** The rules the planner and QA
receive are just as useful to Claude Code, Codex or Copilot editing the same
checkout, so `mcp_server.py` serves them over MCP: `docintel_rules`,
`docintel_adrs`, `docintel_conformance`, `docintel_parse_diagram`,
`docintel_attachments`, `docintel_stacktrace`, `docintel_erd`,
`docintel_sequences` and `docintel_api_test`. Same shape as the brain's server — stdio, JSON-RPC,
no SDK — and two stricter rules. It answers for **one project**
(`--project-dir`, `WORKPILOT_DOCINTEL_ROOT`, or the working directory), and every
path argument must resolve inside it, links included: a tool that reads any path
it is handed is a file reader for whoever can put text in front of the agent.
And it is **read-only** — attachments are read with `persist=False`.
`defusedxml` is imported on first use, so the server starts under another
agent's Python even without it, and only the diagram tools say what is missing.

```bash
claude mcp add workpilot-docintel -- python apps/backend/runners/docintel_mcp.py --project-dir .
```

**A crash is read down to the file.** A person attaching a crash to a task
attaches the one thing that says where the code broke, and an agent handed it
as text re-derived it: grepped for the method, opened the wrong `Program.cs`,
read fifty framework frames before the one the project owns.
`stacktrace.py` parses the frames of every backend WorkPilot builds — .NET
(including `à … dans …:ligne 42` and the other localised runtimes), Python,
Node, the JVM, Go, Ruby, PHP, Rust — and attaches each one to *this*
repository's file. The compiler's artefacts are undone first:
`<Create>d__2.MoveNext` is `OrdersController.Create`, `<>c.<Total>b__4_0` is
`Total`, `lambda$create$0` is `create`, a `.js` under `dist/` is the one `.ts`
that shares its path. The prompt section **Where it broke** lists the project's
frames innermost first, whatever order the runtime printed them in, and counts
the framework (`System.*`, `Microsoft.*`, `node_modules`, `site-packages`,
`java.*`, the Go runtime) instead of listing it.

**Evidence, never a guess.** A frame is attached by the longest run of path
segments the trace and the repository share — which is what tells the two
`OrdersController.cs` of a solution apart, and a Windows build agent's
`C:\agent\_work\1\s\src\…` from a Linux runner's. A bare file name counts
only when it is unique, not a name every project has (`Program.cs`, `index.js`,
`__init__.py`), and the file holds the method. With no path at all — a .NET
release build without PDBs, a Java `Unknown Source` — the type and method are
looked up in the language's sources, and one file declaring the one and holding
the other is required. Two candidates of equal weight are reported
*ambiguous*; a line past the end of the file is dropped and said to come from
another version. An agent sent to the wrong file spends a session there; one
told to look spends a grep. Build output (`bin/`, `obj/`, `dist/`, `target/`)
and dependencies are never indexed, so a frame never lands on a copy.

**The description is read too.** The commonest way a crash reaches a card is
pasted into it, often from a Jira or GitHub import — somebody else's text. So
`task_description` goes through the same cleaning, secret masking and
`injection_guard` as an attachment before a trace is read out of it, and a task
with a pasted trace and no attachment gets a record, where one with neither
still writes nothing.

**A red pipeline is read by the incident model's parsers.** A screenshot or log
of a failed CI run is read for its codes — `CS0103`, `NU1101`, `MSB1009`,
`NETSDK1045`, `TS2345`, `npm ERR! code`, `ERR_PNPM_*`, `error[E0425]`, javac,
kotlinc, go, mypy, pytest collection errors — and its failing tests (pytest,
jest/vitest, go, cargo, `dotnet test`, Gradle, Surefire). The table lives in
`self_healing/incident_responder/cicd_mode.py` and nowhere else: the incident
created from a failed pipeline records the same `build_errors`, titles a
pipeline that does not compile "Build broken" rather than "0 test(s) failing",
and hands the analyzer a **Build Errors** section. Two tables would disagree
the first time a toolchain changes its output. Errors only — a list padded with
the two hundred warnings every solution prints is a list nobody reads — and a
runner's absolute path is resolved to the repository's file the same way a
frame is. `self_healing_runner.py cicd --capture <image|log>` reads a capture
through `docintel` (local OCR, airgap policy, secrets masked, an injection
refused) and uses it as the test output.

**Production incidents use the same reader.** `production_mode` used to match
four regexes and look a bare file name up with `git ls-files`, so a .NET trace
correlated nothing and a common name correlated the wrong file.
`_correlate_stack_trace` is now `stacktrace.analyze`, and the responder's
prompt carries **Where It Broke** beside the raw trace.

**A specification is proposed, never written.** The document a customer sends
— often a scanned PDF, the signed copy that went through the photocopier —
already states the requirements, and what reached the spec pipeline was the
card's title: the spec writer invented requirements the document stated, and QA
held the build to those. `pdf.py` reads a PDF the cheapest way that works: the
text layer, with characters placed where they are on the page so columns
survive; a page with no text is rendered (pypdfium2, else pdf2image; both
imported on first use, a missing one is `no-pdf-backend`) into a temporary
directory, handed to the same OCR chain as a screenshot — same airgap refusal
for a cloud engine — and deleted. Pages are capped (`DOCINTEL_PDF_MAX_PAGES`),
an engine that is absent stops the loop at the first page instead of being asked
twenty times, and the Kanban preview only says *scanned PDF, N pages*: twenty
pages of OCR is not what opening a panel costs. A PDF with a text layer stays a
*document* for the agents; its layer is read only to propose. A secret in a scan
masks the text and withholds the original (`secret-in-scan`): no copy of twenty
rendered pages is painted.

From that text — only text that was masked and that `injection_guard` passed —
`spec_drafts.py` proposes, without a model: requirements (a sentence that
obliges, `shall` / `must` / `doit` / `devra`…, or that carries the document's
own reference, `REQ-12`, `EF-03`, `Exigence 4`; non-functional when it talks
about response times, availability, security, GDPR…), and acceptance criteria
(Given/When/Then and `Étant donné`/`Quand`/`Alors` scenarios, the bullets under
an acceptance heading). **Nothing reaches the spec without a person.** A
proposal is a line in `<spec_dir>/docintel/drafts.json`; the card lists them
with a checkbox and an editable wording, and `decide` is the one writer:
accepted requirements go into `spec.md` under *Requirements from attachments*
with the next free `FR-###` / `NFR-###` *at that moment* (the provisional id
shown before is just that), next to the requirements section so
`spec/traceability.py` reads them like any other, and `traceability.json` is
refreshed when it exists. Before the spec exists they go into the task
description — the path `SpecInterviewBanner` already takes — and
`spec_writer.md` keeps their ids and wording. Accepted criteria join the bullet
editor through its own save path. A heuristic that wrote into the spec by itself
would make every false positive a requirement QA holds the build to: the guess
reading exactly like a decision, which is what `[NEEDS CLARIFICATION]` exists to
prevent. Decisions are keyed by the normalised text, so a second reading never
re-proposes a rejection and keeps what was accepted; the card's edit is one
line, masked like an attachment, and a key that names no proposal adds nothing.

**A rule table is a parametrised test, in the project's language.** A
specification states its rules as tables more often than as prose — a discount
by customer type and amount, a rate by country — and each row is an example.
`tables.py` finds the grid in a Markdown pipe table, an ASCII grid, columns
aligned by spaces (the PDF layout text), or from OCR *word boxes*, where
Tesseract's text has already lost the columns: a cell is a run of words closer
than two character widths, a row belongs while its cells start under the
header's. A grid needs a header and two rows and no cell that reads like a
sentence. Each table gets a draft test for every language the project is
written in (`project.stack_detector`, the repository's one language detector),
in the framework it already references (`test_generation.libraries`): xUnit
`[Theory]`/`[InlineData]` — `TheoryData` when a column is decimal, since an
attribute cannot carry one — NUnit `[TestCase]`, MSTest `[DataRow]`, pytest
`parametrize`, Vitest/Jest `it.each`, JUnit 5 `@CsvSource` in Java or Kotlin,
Go and Rust table-driven tests, PHPUnit data providers, RSpec. French numbers
(`12,5`, `1 000`) are read as numbers, and the expected column is the one whose
header says so (`attendu`, `expected`, `résultat`…), else the last. The table
does not name the function it specifies, and the draft says so rather than
inventing one. The coder receives the tables and one draft each under
**Business rule tables**; a person can dismiss a table that is not one.

**A whiteboard photo becomes a diagram only through a local vision model.**
`whiteboard.py` asks the vision model (`engines/ollama_vision.ask`, the same
loopback-only request as the OCR chain) for the drawing's *model* — boxes,
containers, arrows — as JSON, and writes it as
`attachments/<photo>.whiteboard.drawio`. From there it is an ordinary
attachment: `parse_diagram` reads it, `conformance` holds it against the module
graph the build declares (Maven, Gradle, JS workspaces and Cargo as well as
`.csproj`), and a person opens it in draw.io to correct it. A person asks for
it from the card: whether a photo is a diagram is not something to guess on
every build. No vision model is an answer (`no-vision-model` and why), never a
diagram guessed from OCR words. The file carries `host="workpilot-vision"`, so
the preflight reports it as a model's reading to verify until a person saves it
in draw.io, which rewrites the host — and from then on it is never
overwritten. Labels are masked and scanned before anything is written; only a
file the task carries is converted, so the diagram lands in `attachments/`.

What reaches a prompt from this is built from the repository's own paths and
from symbols matched by character classes that admit no sentence; a message a
tool printed (a CI error's text) is quoted inside the attachment fence, as data.
Text flagged by `injection_guard` is never diagnosed at all.

**What the screens show is reviewed too (lot E).** The QA reviewer judged a
change from its diff and its tests; what a person would *see* reached it as
pixels at best. Three defects show on a screen and nowhere else, and no test
catches them because each test runs in one locale and asserts one string: a
translation key displayed as is, a language that is not the screen's, a label
cut by its container. `visual_qa.py` reads every capture of the running
application through the same OCR chain as an attachment (`preflight.read_screen`
— local engines, the airgap refusal, secrets masked, `injection_guard`) and
`screens.py` checks each one. Before every QA pass `qa/loop.py` calls
`qa/report.run_visual_qa`; the record lands in `<spec_dir>/docintel/visual_qa.json`,
`docintel_section` hands it to the reviewer (and to the fixer after it) fenced
as data, and `write_visual_qa_report` puts the same lines into `qa_report.md`
between markers, replaced in place on every pass — the report carries the
evidence whether or not the reviewer quoted it. A capture whose file did not
change is not read again, so a QA loop of ten passes pays the OCR once.

| Where a capture comes from | How it is found |
|---|---|
| the App Emulator's preview, the device frame (`TaskMobilePreview`) | `POST /api/docintel/captures` writes `captures/{base,task}/<platform>--<route>--<locale>.png` and a manifest entry |
| `device-runner` | its prompt names the same directory and the same file name |
| Visual Proof | the run `task_metadata.json` → `visualProof` names, under `visual-proofs/<spec>/<run>/` |
| the store listing | fastlane's `screenshots/<locale>/` and `metadata/android/<locale>/images/` |

**Every path is a key, never a path to open.** The capture endpoint takes an
image and says what it shows — side, route, locale; the file name is built by
the server, so a second capture of a screen replaces the first and a base and
a task capture of one route pair up. A Visual Proof `relativePath` read back
from `task_metadata.json` contributes its *file name*, looked up in the listing
of the run's own directory. No listing follows a link.

**The side is a fact, not a choice.** The emulator's server runs in the task's
worktree or in the repository itself, and that decides `task` or `base`
(`captureSide` in `TaskEmulator`). A base and a task capture of the same route
are diffed label by label — changed, added, removed — which is what a reviewer
of the pull request wants to look at first.

**The same label, tolerantly.** OCR reads `Enregistrer` as `Enreqistrer`, drops
an accent, glues a colon to the word; a diff that reported that as a change
would be always full and read by nobody. `labels.normalize_label` removes what
never carries meaning on a screen (case, accents, punctuation, a trailing
ellipsis) without folding a non-Latin script to nothing, and one edit on a label
of six letters or more is an OCR slip. A rewording is paired by edit similarity,
or when one label extends the other word for word (`Annuler` → `Annuler la
commande`). A toolbar Tesseract returns as one line is split into its buttons
where the gap between words is wide — `tables.row_cells`, the split a table
row already uses, not a second one.

**A key is found in every stack's spelling, and a URL is not one.** i18next
`namespace:section.key`, ngx-translate `HOME.TITLE`, dotted keys, Spring
`???key???`, Rails `[missing "…" translation]`, Android `@string/…`, and the
unresolved placeholders (`{{name}}`, ICU `{count}`, `${x}`, `{0}`, `%s`). A
token is a key only when a developer would have written it — an underscore, a
camelCase hump, three segments — and never when it ends in a file extension or
a TLD: a detector that flagged `www.example.com` would be switched off in a week.

**A language is judged on evidence only.** A lexicon per language (function
words and the words interfaces are made of), with every word two languages
share removed from both. A screen needs three words of evidence and twice the
runner-up's score; below that it has no language and nothing is drawn from it.
The locale is the capture's (the manifest, the URL's `/fr/` or `?lang=`, the
store directory); without one, the screen's own dominant language stands in,
and three English buttons on a French screen are reported as mixed.

**Which screen it is.** A crash dialog (Android, iOS, React Native's red box,
Flutter), an error page (ASP.NET, Spring's Whitelabel, a Django traceback,
Express's `Cannot GET`), a sign-in wall, a blank screen. A capture of a login
page is not evidence the feature works — the reviewer is told to write "not
verified on screen", never "verified" — unless the route is a login route.

**Mockup against render: structured first.** A `*.figma.json` attachment —
lot F's contract, `{"source": "figma", "file_key", "frames": [{"id", "name",
"texts"}]}`, and nothing looser — is read as data; its texts are masked and
scanned like any attachment. A mockup *image* (named so: `mockup`, `maquette`,
`wireframe`, `design`…, because the screenshot of the bug being fixed is not
what to build) is OCR'd only when no Figma file says it better. Each frame is
held against the task capture that shows most of it; in a file with several
frames, a frame no capture shows a third of is another screen of the product
and is counted, not reported. A label near but not equal is `mockup-near`
(low), one absent is `mockup-missing` (medium).

**OCR is evidence, not a verdict.** Every finding carries a severity (a crash
or an error page high, a raw key, a wrong language or a cut label medium, a
foreign word or an ellipsis low), and the reviewer is told to open the capture
before reporting it. A capture whose text `injection_guard` flags is withheld
whole; labels built from OCR boxes are masked again, and taken from the masked
text instead when the screen showed a secret, because a key split across two
boxes would slip past a per-box mask. The store auditor reads the same record
for the listing's screenshots, with placeholder text (`Lorem ipsum`, `TODO`) as
a store-listing finding.

`VisualReviewCard`, in the task panel, shows the counts, the findings, what
changed on screen from base to task, and each mockup's coverage; it offers to
read captures that are waiting (`POST /api/docintel/visual/run`, the QA loop's
own step on request) and renders nothing when the task has no capture.
`GET /api/docintel/visual` reads the record and *lists* the captures — OCR of a
dozen screens is not what opening a panel costs.

**In the Kanban.** `DocumentInsightsCard` says, before the build, what each
attachment will become (diagram, OCR text and the engine that read it, image,
document, masked, withheld) and which ADRs bind — the moment someone can still
attach the `.drawio` instead of its screenshot, or a screenshot without the
key on it. A secret is shown by its kind; the card never receives the value. A
stack trace or a failed build — attached or pasted in the description — is
shown located: how many frames the project owns and which one to open first,
or which codes the build failed on. It also counts what the diagrams say of the
code — the ERD's differences with the mapping, a sequence's verified calls,
each attached HTTP call and where its test goes. `AttachmentDraftsPanel`, inside
it, offers to read a specification now (`POST /api/docintel/drafts/extract`, the
build's own preflight on request — the one place outside a build where a
scanned PDF is OCR'd, because a person pressed the button and is waiting), lists
the proposals to tick, edit, add or reject (`POST /api/docintel/drafts/decide`),
shows each rule table with its test per language, and converts a whiteboard
photo (`POST /api/docintel/whiteboard`) or says why it cannot. `FigmaLinkRow`
links a mockup when the project has a Figma token. It renders nothing
when there is neither attachment, nor ADR, nor trace, nor a diagram to hold
against the code, nor a mockup to link — and the panel nothing when nothing is
proposed. What a person decides there is also filed in the shared brain (see
*Ce que docintel a validé*).

| Variable | Default | What it does |
|---|---|---|
| `DOCINTEL_ENABLED` | `true` | The attachments preflight. ADRs are read regardless |
| `DOCINTEL_LOCAL_OCR` | `true` | The OCR master switch: off, no engine is asked, cloud included |
| `DOCINTEL_OCR_ENGINE` | `tesseract` | Ordered fallback chain: `tesseract`, `paddleocr`, `doctr`, `ollama-vision`, `azure-document-intelligence` |
| `DOCINTEL_OCR_LANGS` | `eng+fra` | OCR languages (Tesseract spelling); retried without `-l` when a pack is missing |
| `DOCINTEL_VISION_MODEL` | `qwen2.5vl` | The Ollama model `ollama-vision` asks; an unpulled model is a recorded reason |
| `DOCINTEL_AZURE_ENDPOINT` / `DOCINTEL_AZURE_KEY` | — | Azure Document Intelligence, https only. Both required, and the engine listed, before anything is sent |
| `DOCINTEL_MAX_BYTES` | `10485760` | Larger attachments are skipped and the skip is reported |
| `DOCINTEL_PDF_MAX_PAGES` | `20` | Pages of a scanned PDF rendered and OCR'd per reading; the rest is reported, not read |
| `WORKPILOT_TESSERACT_PATH` | — | A specific binary, for a Tesseract not on PATH and for tests |
| `FIGMA_ACCESS_TOKEN` | — | Read-only Figma token for linking mockups; written from Settings → Figma, never sent to the renderer |

Read from `.workpilot/.env` as well as the environment; real variables win.
