# Library documentation (libdocs)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Library Documentation (`libdocs`)

Before every build, one question: *is there a library in this task that the repository
shows no example of?* When there is, its current documentation is downloaded from
Context7 and staged next to the spec, and the coder is told to read it before writing
code against that library.

```
apps/backend/libdocs/
  detect.py     which libraries this task needs, and which the repo already teaches
  context7.py   the REST client (`/v2/libs/search`, `/v2/context`)
  cache.py      .workpilot/docs-cache/, shared between specs, 14-day TTL
  preflight.py  runs the three, stages the pages, renders the prompt section
```

**The signal is usage evidence, not popularity.** A library imported in twenty files is
skipped deliberately — the codebase teaches it better, house conventions included. One
declared and imported nowhere, or named by the task and in no manifest at all, is the
case this exists for: there is nothing to copy, so the model writes the API it remembers.

A task that names no library at all falls back to the declared dependencies nothing
imports yet — but **only on a project under ~50 source files**. A mature repository has
examples of its own stack by definition, so guessing there would spend the budget on
whichever dependency sorts first.

**Why this and not just the MCP server.** Context7 stays declared for the coder, the
researcher and the reviewers, and mid-session `mcp__context7__query-docs` is exactly
right. The failure it cannot cover is the other one: the agent does not notice it should
ask. Reading manifests does not require the model to doubt itself.

**It never fails a build.** No network, no key, quota spent, library not indexed — the
result records why, one line is printed, and the session proceeds.

| Variable | Default | What it does |
|---|---|---|
| `CONTEXT7_API_KEY` | — | Raises the quota above the anonymous per-IP one. Also passed to the MCP server. Free key: context7.com/dashboard |
| `CONTEXT7_ENABLED` | `true` | Turns off the MCP server **and** the preflight — one decision about sending task text to Context7 |
| `LIBDOCS_ENABLED` | `true` | Turns off the preflight alone |
| `LIBDOCS_MAX_LIBRARIES` | `4` | Pages downloaded per build |
| `LIBDOCS_TTL_DAYS` | `14` | How long a cached page is served before it is fetched again |
| `CONTEXT7_API_URL` | `https://context7.com/api` | Self-hosted or proxied index. Read by the MCP server too |

All of them are read from `.workpilot/.env` as well as the environment, so the toggle
and key set in Settings → Agent Tools → MCP Servers reach the preflight and not only the
MCP server. Real environment variables win over the file.

**Note on the MCP tool names.** `@upstash/context7-mcp` renamed `get-library-docs` to
`query-docs` (`libraryId` + `query`, no `topic`/`mode`), and the server is started
unpinned, so both names are allowlisted — an entry for a tool the running server does
not expose is inert, a missing entry for the one it does expose is silent failure.
