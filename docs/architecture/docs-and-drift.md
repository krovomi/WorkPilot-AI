# Docs et dérive

The hub "Docs et dérive" has two tabs: **Documentation** (coverage and draft
doc comments) and **Détecteur de dérive** (documentation that cites code the
project no longer has). Both read every language WorkPilot supports and are
built with the [UI charter](ui-charter.md).

## Languages

`apps/backend/doc_languages/` (a leaf: the standard library only) is the one
table of source languages: extensions, declaration patterns (types, functions,
methods, `impl`/`extension` owners), the doc comment above a declaration, and
the doc comment convention to draft:

| Language | Doc comment drafted |
|---|---|
| C# / .NET | XML doc (`/// <summary>`, `<param>`, `<returns>`) |
| Java, Kotlin, Scala, PHP, TypeScript / JavaScript (Vue, Svelte, Astro) | Javadoc / KDoc / Scaladoc / PHPDoc / JSDoc block |
| Go | godoc line starting with the name |
| Rust | rustdoc `///` with `# Arguments` |
| Swift | `///` with `- Parameter` / `- Returns` |
| Dart / Flutter | `///` |
| Ruby | YARD `# @param` |
| C / C++ / Objective-C | Doxygen `@brief` / `@param` |
| Python | read by the AST (`agents/documenter.py`), Google / NumPy / Sphinx docstrings |

A symbol is `documented`, `partial` (a comment that does not describe the
parameters, where the convention has a tag for them) or `missing`. The reader
is line based and prefers missing a symbol to inventing one.

## Documentation tab

`runners/documentation_runner.py`, actions `project` (coverage of every source
file, per language, files to document first), `coverage` (one file),
`docstrings` (drafts for the undocumented symbols of one file) and `readme`
(one folder). Paths are relative to the project; one that resolves outside it
is refused. Nothing is written to the project: drafts are copied by the user.

The tab used to `fetch` a relative `/api/documentation/...` URL from the
renderer, which never reached the backend in the desktop app; it now goes
through IPC (`documentation:run`, `main/ipc-handlers/documentation-handlers.ts`).

## Drift detector

`runners/doc_drift_runner.py` calls `doc_drift_detector/project.py`, which the
CLI and the QA gate share (#354). No model is called anywhere. It reads `.md`,
`.mdx`, `.rst` and `.adoc`, the source files of every language above, and git:

```
doc_drift_detector/
  drift_scanner.py  functions and files cited in `backticks`
  signatures.py     doc comments against the declarations below them
  examples.py       the fenced code blocks of the documents
  staleness.py      documents the code moved past (git), freshness score
  autosync.py       the fixes simple enough to make without a model
  project.py        one scan of a project, or of a change set
  __main__.py       python -m doc_drift_detector check
qa/doc_drift_gate.py  the QA gate (WORKPILOT_QA_DOC_DRIFT)
```

| Type | Severity | What |
|---|---|---|
| Function not found | high | a `` `name(` `` the code no longer contains (a name any source file still writes is fine: a library call) |
| File not found | medium | a `` `path/to/file.ext` `` found neither next to the document, nor from the root, nor as the tail of one project path; fixable when exactly one project file has its name |
| Doc comment out of date | high | the comment names a parameter the code no longer takes; the same count with a name changed in place is a rename, fixable |
| Type out of date | medium | Python: a docstring type that is a plain name and differs from the annotation (`amount (int)` over `amount: float`), fixable |
| Parameter not described | low | the comment describes some parameters, not this one |
| Example does not parse | medium | a Python block (doctest prompts read as code) or a JSON document that does not parse |
| Example imports what is gone | high | an import of the project's own code naming a module or a name it no longer has |
| Example call out of date | high | Python: a call to a project function with too many arguments, a missing one, or an unknown keyword |
| Probably out of date | low, medium after 30 days | git: code the document is about was committed after the document |
| Document not updated | low | change-set mode only: the change edits code a document is about, not the document |

**Doc comments.** `@param` (JSDoc, Javadoc, KDoc, Scaladoc, PHPDoc, Doxygen,
YARD), `<param name="">` (.NET), `- Parameter x:` / `- Parameters:` (Swift),
`` * `x` - `` under `# Arguments` (rustdoc), Google, NumPy and Sphinx
docstrings (Python, read with `ast`). The declaration's own parentheses are read
again with nesting, strings and comments, so `(fn: () => void, x)` is two
parameters. Not compared, since nothing would be certain: a comment without
parameter tags (godoc, dartdoc, prose), a destructured, rest or variadic
parameter, type parameters documented with `@param <T>` / `@param T`, the
removed names of a Python function taking `**kwargs`.

**Examples.** The project's own code is known per stack: Python packages (a
folder with `__init__.py` whose parent has none; every suffix of a module path
is a candidate import name), `package.json` names, `go.mod` modules, Cargo
crates, `pubspec.yaml` packages, Composer PSR-4 prefixes, the namespaces and
packages the .NET and JVM sources declare, gemspecs. An import of anything else
(a library) is never checked; a name is missing only when no source file writes
it. A block with placeholders (`<your-key>`, `${API_KEY}`, `{{x}}`), a JSON
excerpt (`"key": {…}`), JSONC, several JSON documents, and a call with
`*args` / `**kwargs` unpacking are not reported. Blocks indented inside a list
are dedented first. Examples are not run: the sandbox to run arbitrary
snippets safely is left out on purpose.

**Staleness and freshness.** A document is linked to the files it cites, the
files declaring the functions it cites (when at most three do) and, for a
README inside a folder, that folder's code. `git log` over two years gives each
file's commit times; a linked file committed after the document's own last
commit makes it stale since that commit. The score of a document starts at 100,
loses 20 / 10 / 5 per high / medium / low problem and 10 plus 5 per month of
staleness (at most 40), never below 0; the page shows the average and the least
fresh documents. A translated document (`README.fr.md`, `docs/fr/…`) is checked
on its own and carries its language.

**`<!-- no-drift-check -->`** on a document's first line (after its front
matter) skips the document; elsewhere it skips the next fenced block or
paragraph. `no-drift-check` inside a doc comment skips that declaration: a
document about the next version, a deprecated API kept on purpose.

**Fixes** (`autosync.py`): a rename in a doc comment, a Python docstring type,
a moved file's path. The page sends the ids of the last scan; main revalidates
them (`main/doc-drift/fix-run.ts`, S6) and opens a review card
([generated-review.md](generated-review.md)); the runner's `--fix` remakes each
fix only if the drift is still there in the worktree, keeps CRLF files CRLF,
and never writes outside the project or through a symbolic link. A server
project's fixes are not offered: its files are not on this computer.

**Export.** JSON keeps the report's machine fields only; HTML is worded by the
renderer in the app's language and escaped in main, with `default-src 'none'`.

**QA gate and CI.** After the reviewer approves, `qa/doc_drift_gate.py` scans
the task's own change set and writes `doc_drift.json` in the spec folder.
`WORKPILOT_QA_DOC_DRIFT`: `warn` (default) logs, `strict` sends a high problem
back to the fixer, `off` stops it. `python -m doc_drift_detector check
--target develop` (from `apps/backend`) does the same for a branch: GitHub
Actions annotations (`::warning`), exit 0, 1 with `--strict` on a high
problem, 2 when the comparison cannot be made (no git, an unknown or
option-like target).

Not done: semantic drift read by a model (the docs say "returns an int", the
code returns a float), rewording the sentence around a fix, cross-repository
docs, running the examples.

Not reported, because they do not describe the code as it is: changelogs and
release notes, agent skills, templates, examples, fixtures, prompts and the
audit; paths under generated folders (`dist`, `build`, `node_modules`,
`target`, `bin`, `obj`…), absolute, home, glob or abbreviated (`tests/.../x`)
paths, local `.env*` files, and paths whose first folder exists nowhere in the
project (they describe another repository). A server project runs the scan on
the server (`shared_features/analyses.py`).

## Python environment

Both runners (and every analysis runner of the app) get the interpreter from
`main/utils/ensure-python.ts`: it starts or joins the managed environment's
initialization instead of failing with "Python environment not ready" when no
task has run yet (F163).
