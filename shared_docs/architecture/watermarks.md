# Clean generated files (watermarks)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Clean generated files (watermarks)

[watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover)
(Guillaume Meyer, MIT) removes provenance marks from content you own. Most of it
is about images, PDFs and audio; one part of it is about text, and that part
answers a question this repository had never asked: **what invisible characters
are in the files the agents write?**

Zero-width spaces, exotic spaces, bidirectional controls and tag characters are
how a statistical or vendor watermark rides in model output. In prose they are
harmless and invisible. In a source file they are a `SyntaxError` nobody can
see, an identifier that does not match itself, a `grep` that finds nothing, and
a diff full of changes no one made — and they survive every copy-paste into a
repository. Generated code is the case where the cost is highest and the
detection is hardest.

```
apps/backend/vendor/watermarks/  the pinned upstream table (scripts/vendor_watermarks.py)
apps/backend/watermarks/
  runtime.py   is the vendored table loadable, and is the tree its receipt's one
  settings.py  has the user turned it on, and how aggressive may it be
  clean.py     text on its way to disk -> clean text, and what changed
  hook.py      the PreToolUse hook every agent Write and Edit passes through
  ledger.py    <spec_dir>/watermarks.jsonl — the record of every silent edit
  api.py       GET /api/watermarks/status
```

**One file is vendored, not fifty.** `service/scripts/text_unicode.py` is Layer
A: the decision table that says which invisible codepoint is a carrier and which
is load-bearing — a ZWJ inside an emoji sequence, a joiner between two Arabic
letters, a filler after a Hangul jamo. 25 KB, stdlib-only, importing nothing
from its siblings, which `test_watermarks_vendor.py` asserts by parsing it
rather than importing it. The rest of upstream has no consumer here: the image
and container metadata strippers are for files a coding agent does not write,
and Layer B removes statistical marks by **paraphrasing** — a build that
silently reworded the code it just wrote would be a different product.

Committed rather than bootstrapped like the packs under `skills/`, for the same
reason as archify and a sharper one: this runs on every file of every build, so
a cleaner that works only where somebody ran an install command produces output
nobody can rely on. And the table is **never reimplemented** — same rule as
`rtk.rewrite` delegating to `rtk rewrite`. Two copies of a Unicode policy is two
answers to one question, and this one is subtle enough that the second copy gets
the preservation rules wrong long before anyone notices.

**One change reaches every feature.** Planner, coder, QA fixer, the spec
pipeline, the GitHub runners, the mobile phases — none of them write a file of
their own, they all go through `core.client.create_client`, so the hook is
registered there once. The providers that do not use the Claude SDK execute
their writes in `core/runtimes/tool_executor.py`, which is the same cleaning in
the other half of the product, exactly where `rtk_rewrite` already sits — and
the same *record*, which took longer to be true than the cleaning did. Not one
of those clients passed a spec directory down to the executor, so
`ToolExecutor.spec_dir` was always `None` and the ledger below was never written
on a non-Claude build: the bytes were edited and the one file that says so did
not exist. `create_agent_client` hands each client its `spec_dir` now, and
`test_watermarks_hook.py` fails on a `ToolExecutor(...)` built without one —
the cleaning is visible in the file, the record is the only evidence of what was
taken out of it, and a call site that forgets it loses that silently.

**`Pre`, not `Post`, and that is the whole design.** A PostToolUse hook would
read the file back, rewrite it, and leave a second mtime behind: a dev server
reloading twice, a watcher firing twice, and a window where the dirty bytes are
on disk and a test runner can read them. Rewriting `updatedInput` means those
bytes never exist.

**`old_string` is never touched.** `Edit` finds its target by matching that
field against the file *as it is on disk*, and a file that already carries an
invisible character carries it in the match too. Cleaning the needle is how a
working edit turns into "string not found" — and nothing is lost by leaving it
alone, because `new_string` is what lands.

**It never decides whether the write happens.** Like `rtk_rewrite_hook`, it
returns `updatedInput` and nothing else. The guardrails hook registered on the
same tools answers the permission question; a second hook that only knows about
invisible codepoints must not get a vote on it.

**Two of upstream's defaults are inverted, and two of its knobs are unreachable.**

| Option | Here | Why |
|---|---|---|
| `normalize_spaces` | **off** (upstream: on) | U+00A0 is load-bearing in the two languages this product ships: French typography puts one before `?`, `!`, `:`, and `fr/*.json` is full of them. Rewriting those loses a decision a translator made |
| `strip_bidi` | **off**, switchable | A paired RLE/PDF run is how Arabic and Hebrew are written. Turning it on is the Trojan Source hardening (CVE-2021-42574), where the attack *is* a well-formed embedding — worth having, worth being a decision. Unpaired and out-of-context controls go either way |
| `nfkc` | **not offered** | Folds `ﬁ` to `fi` and `４` to `4`. In a paragraph that is tidying; in a string literal, a regex class or a test fixture it is a silent behaviour change, and the file still compiles |
| `aggressive_homoglyphs` | **not offered** | Rewrites Cyrillic `а` to Latin `a`. A homoglyph in an identifier is worth catching — that is `injection_guard`'s catch, with a finding somebody reads — not something to fix by editing a Russian translation into nonsense on the way to disk |

**The model is not told, and that is not the same as nobody being told.** rtk
gets an awareness paragraph because a model handed forty lines where it expected
four hundred will doubt the result and run the command again. Here the change is
invisible by definition: a warning would describe something the model cannot
observe, and the only thing it could do with one is second-guess correct output.
But this is the one place in a build where WorkPilot edits bytes a model wrote
without saying so, so every change appends a line to
`<spec_dir>/watermarks.jsonl` — the file, the tool, the codepoints by name. A
reviewer asking why a line differs from what the transcript shows has the answer
next to the plan and the QA report.

**Nothing here can fail a build.** No vendored tree, a switch turned off,
content above the cap, upstream raising: the content is written exactly as the
model produced it and the reason is recorded rather than hidden. The cost on a
file with nothing to strip is a single `str.isascii()` — every codepoint the
table can touch is non-ASCII, and
`test_watermarks_vendor.py::test_no_ascii_codepoint_is_ever_touched` checks all
128 of them, because that is upstream's property to keep and not ours to assume.
The day a release breaks it, the fast path would skip exactly the files that
needed the work, silently, on every build.

| Variable | Default | What it does |
|---|---|---|
| `WATERMARKS_ENABLED` | `true` | The master switch. The only way to turn the feature off |
| `WATERMARKS_NORMALIZE_SPACES` | `false` | Rewrite U+00A0 and its fifteen siblings to a plain space |
| `WATERMARKS_STRIP_BIDI` | `false` | Strip well-formed bidi embeddings too — the Trojan Source hardening |
| `WATERMARKS_MAX_BYTES` | `1048576` | Above this the content is passed through and the skip is reported. A nonsense value falls back to the default rather than disabling anything through a knob documented as a size |

All of them are read from `.workpilot/.env` as well as the environment, so what
Settings writes reaches the hook, the tool executor and the status endpoint from
one place. Real environment variables win.

**How it is verified.** The layers split by what they need, the same way rtk's
do:

| Layer | Proven by | Where |
|---|---|---|
| the settings, the skips, the cap, the failure paths | our own wrapper | `tests/test_watermarks_clean.py` |
| what the hook rewrites, and the `old_string` it refuses to | fabricated tool calls | `tests/test_watermarks_hook.py` |
| that the table still behaves the way this integration assumes | the vendored tree itself | `tests/test_watermarks_vendor.py` |

The last row is the one that matters when somebody moves the pin
(`python3 scripts/vendor_watermarks.py --ref …`). It asserts what must hold of
*any* version — self-contained, the API driven here, no ASCII codepoint touched,
a ZWSP removed and the joiners kept — and never that one exotic codepoint has
one particular fate, because upstream's table grows with every release and a
test pinning one entry of it gets deleted within a month.
