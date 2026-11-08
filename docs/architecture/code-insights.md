# Code review and Refactoring views (code insights)

The "Revue de code" and "Refactoring" views of the Development group read code
the user pastes (a patch, a snippet) and return findings without calling a
model. Audit finding F163.

## Path

```
renderer (CodeReview.tsx, RefactoringView.tsx)
  └─ window.electronAPI.runCodeInsights({ action, text, language? })
       └─ main: ipc-handlers/code-insights-handlers.ts   ("codeInsights:run")
            └─ runners/code_insights_runner.py            (request on stdin)
                 ├─ review   → agent_endpoints/code_review.analyze_diff → review/ai_code_review.py
                 ├─ smells   → agents/refactorer.SmellDetector
                 ├─ propose  → agents/refactorer.RefactoringAgent
                 └─ languages
```

- **Why IPC and not `fetch`**: the views used to fetch a relative `/api/...` URL.
  `VITE_BACKEND_URL` only exists in the development `.env`, so in the packaged
  app the request never reached the backend.
- **Why stdin**: a patch can reach 2 MB; a command line cannot carry that on
  Windows, and the text never becomes an argument the runner could misread.
- **Trust boundary** (S4, S6): the main process revalidates the action, the
  text (non-empty, at most 2 MB) and the language id (`^[a-z+#]{1,20}$`); the
  runner checks them again. The runner gets `pythonStaticRunnerEnv`: tool paths
  and the managed Python only, no backend `.env`, no provider key, no Claude
  profile (S1), since nothing here calls a model.
- The HTTP routes `/api/refactoring/*` and `/api/code-review/analyze` stay for
  the server mode.

## Every stack

- **Smells**: Python goes through `ast`; every other language of
  `doc_languages` goes through `agents/refactorer_polyglot.py`, a line-based
  reader (declarations from `doc_languages`, bodies closed by their braces or by
  Ruby's `end`). Nesting counts control blocks only, Allman braces included.
  Like `doc_languages`, it prefers missing a smell to inventing one.
- **Language of a snippet**: the view offers "Auto-detect" and every language
  the reader knows; in auto mode `guess_language` scores syntax hints, falls back
  to Python, and the view shows "Read as …".
- **Review rules**: `review/polyglot_rules.py` adds, per stack, silent error
  handling, debug output left in, crash-prone shortcuts (`unwrap()`, `try!`,
  `!!`, `async void`, `.Result`), SQL built by concatenation, shell execution
  and unbounded C string functions. Each rule only flags what one added line
  proves.
