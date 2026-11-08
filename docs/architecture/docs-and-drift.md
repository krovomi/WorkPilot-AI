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

`runners/doc_drift_runner.py` + `doc_drift_detector/drift_scanner.py`. It reads
`.md`, `.mdx`, `.rst` and `.adoc` and reports:

- **Function not found** (high): a `` `name(` `` the code no longer contains.
  A name is fine when it is a declared symbol (bare or `Owner.member`) or when
  any source file still writes it (a library function the project calls).
- **File not found** (medium): a `` `path/to/file.ext` `` that exists neither
  next to the document, nor from the project root, nor as the tail of a
  project path.

Not reported, because they do not describe the code as it is: changelogs and
release notes, agent skills, templates, examples, fixtures, prompts and the
audit; paths under generated folders (`dist`, `build`, `node_modules`,
`target`, `bin`, `obj`…), absolute, home or glob paths, local `.env*` files,
and paths whose first folder exists nowhere in the project (they describe
another repository). A server project runs the scan on the server
(`shared_features/analyses.py`).

## Python environment

Both runners (and every analysis runner of the app) get the interpreter from
`main/utils/ensure-python.ts`: it starts or joins the managed environment's
initialization instead of failing with "Python environment not ready" when no
task has run yet (F162).
