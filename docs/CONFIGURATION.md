# Configuration

This document is the single reference for how WorkPilot AI loads its runtime
configuration. It covers:

1. The LLM provider registry (`configured_providers.json`).
2. The per-user provider configurations (`~/.work_pilot_ai_llm_providers.json`).
3. The authentication token resolution order.
4. Multi-user server mode: tenants, roles and permissions.

The sections after these four list the environment variables each feature
reads, starting with [where they are read from](#where-environment-variables-are-read-from).

---

## 1. LLM provider registry — `configured_providers.json`

**Location:** [config/configured_providers.json](../config/configured_providers.json).
**Format:** JSON.
**Source of truth for:** both the **backend** (Python) and the
**frontend** (TypeScript).

Consumers:

- **Backend Python** — [core/configured_providers.py](../apps/backend/core/configured_providers.py)
  (typed loader with validation) and [provider_api.py](../apps/backend/provider_api.py#L1).
  Validated against `ConfiguredProvider` at load time — malformed entries
  raise immediately instead of silently propagating empty strings.
- **Frontend TypeScript** — read at runtime over IPC
  (`providers:getConfiguredProviders`) by
  [`shared/services/providerService.ts`](../apps/frontend/src/shared/services/providerService.ts),
  which falls back to `providerRegistry` when the bridge is absent. A generated
  `providers.generated.ts` (and its `generate:provider-types` script) existed but
  nothing imported it; audit lot L8 removed both.

The file must not be duplicated. A previous copy at
`utils/config/configured_providers.json` has been removed; any reference
to that path is stale and should point at `config/`.

### Shape

```json
{
  "providers": [
    {
      "id": "anthropic",
      "label": "Anthropic (Claude)",
      "models": ["claude-3-5-sonnet-20241022", "claude-opus-4-7"],
      "default_model": "claude-opus-4-7",
      "capabilities": ["chat", "tools", "streaming"]
    }
  ]
}
```

If you add a new provider field, update both consumers in the same PR:
- backend: `apps/backend/provider_api.py`
- frontend: `apps/frontend/src/renderer/services/providers.*` (or equivalent)

---

## 2. Per-user provider config — `~/.work_pilot_ai_llm_providers.json`

**Location:** user home directory.
**Owner:** [src/connectors/llm_config.py](../src/connectors/llm_config.py).

Stores user-specific provider settings (API keys, base URLs, model
overrides) and the currently **active** provider. Managed from the app's
settings through `provider_api.py`:

| Endpoint | Does |
|---|---|
| `GET /providers/configs` | list the saved configurations |
| `POST /providers/config/{provider}` | save a provider's configuration |
| `DELETE /providers/config/{provider}` | delete it |
| `POST /providers/select` · `GET /providers/selected` | set / read the active provider |
| `POST /providers/test-key/{provider}` | check an API key against the provider |
| `GET /providers/effort?provider=…&model=…` | what each effort level becomes on that model (`core/effort_plan.py`): `native`, `none` (no effect) or `runtime` (Copilot, Ollama) |

The `python -m apps.backend.cli provider …` commands this section used to
list never existed (there is no `cli/__main__.py`), and the `--provider-action`
option of `run.py` that they stood for was parsed and never dispatched; it was
removed in audit lot L9.

Internally, the active provider is stored under the reserved key
`__active_provider__`. That key is filtered out of `list_provider_configs()`,
so it never appears as a "configured provider" in the UI.

### How the model dropdowns learn about new releases

Every model selector reads `GET /providers/models/{provider}/catalog`
([provider_models_catalog.py](../apps/backend/provider_models_catalog.py)),
which answers from the first source that works:

| Order | Source (`source` field) | When |
|---|---|---|
| 1 | `cache` | a provider answer less than 6 h old (`~/.work_pilot_ai_model_cache.json`) |
| 2 | `live` | an API key is configured: the provider's own `/v1/models` — exactly what the account may call |
| 3 | `registry` | no key (Claude Code subscription, Copilot, Bedrock…): the public [models.dev](https://models.dev) registry, cached 6 h in `~/.work_pilot_ai_model_registry.json` |
| 4 | `cache` (stale) | everything above failed |
| 5 | `static` | offline: the list generated from `models_registry.py` |

Both network sources go through the same per-provider allow-list, and the
registry **adds** to the static list rather than replacing it. A new model
therefore appears in the dropdowns within six hours of being listed, with no
code change; the refresh button next to a selector forces it immediately.

| Variable | Default | What it does |
|---|---|---|
| `MODEL_REGISTRY_ENABLED` | `true` | `false` removes the registry source (no request to models.dev) |
| `MODEL_REGISTRY_URL` | `https://models.dev/api.json` | a mirror or self-hosted copy of the same document |

---

## 3. Authentication token resolution order

Implemented in [apps/backend/core/auth.py](../apps/backend/core/auth.py)
(`get_auth_token`). The first source that yields a token wins.

| # | Source | Notes |
|---|--------|-------|
| 1 | `CLAUDE_CODE_OAUTH_TOKEN` env var | OAuth token from Claude Code CLI. |
| 2 | `ANTHROPIC_AUTH_TOKEN` env var | For CCR / proxy / enterprise setups. |
| 3 | `config_dir` argument | Explicitly passed by the caller. |
| 4 | `CLAUDE_CONFIG_DIR` env var | Profile-specific config directory. |
| 5 | `.credentials.json` in (3) or (4) | File-based storage. |
| 6 | System credential store | macOS Keychain, Windows Credential Manager, Linux Secret Service (via `secretstorage`). |

### API profile mode (`ANTHROPIC_BASE_URL`)

Setting `ANTHROPIC_BASE_URL` sends the Claude Agent SDK to an Anthropic-compatible
endpoint instead of the OAuth sign-in. In that mode `ANTHROPIC_AUTH_TOKEN` is
required (the session stops with an error without it) and
`CLAUDE_CODE_OAUTH_TOKEN` is dropped. A base URL set next to an OAuth token but
without `ANTHROPIC_AUTH_TOKEN` is taken as stale: it is removed, with a warning,
and OAuth is used. The desktop app sets the variable from the active API
profile and clears it in OAuth mode, so setting it by hand only matters for the
CLI.

Against Anthropic's own API, WorkPilot sets `ENABLE_TOOL_SEARCH=auto:5`: MCP tool
schemas are deferred once they weigh more than 5% of the context window. Behind
any other base URL it sets nothing, and the Claude Code CLI keeps tool search
off, because a proxy that does not forward `tool_reference` blocks would lose
every deferred tool. If your proxy forwards them, export `ENABLE_TOOL_SEARCH`
(`true`, `auto` or `auto:N`); a value you export is never overridden.

### Deliberately **not** supported

- **`ANTHROPIC_API_KEY`** is intentionally excluded. Supporting it could
  silently bill the user's API credits if the OAuth path misconfigures —
  a failure mode we've explicitly ruled out.
- **`CLAUDE_API_KEY`** is not a token source either. It only makes the
  provider list report Claude as configured, so a build can still stop for
  lack of an OAuth token while the UI shows Claude as available.

### Linux-specific requirement

On Linux, reading from the system credential store requires the optional
`secretstorage` package. If it is not installed, the backend logs a
**warning at startup** and the keychain path is skipped — tokens will only
be resolved from env vars or the credentials file.

```bash
pip install secretstorage
```

### Encrypted tokens

Tokens prefixed with `enc:` are Claude Code CLI-encrypted. They are
auto-decrypted via `_try_decrypt_token`. If decryption fails, the backend
raises a clear error pointing the user at `claude setup-token`.

---

## 4. Multi-user server mode — tenants, roles and permissions

Everything below applies **only** when `WORKPILOT_SERVER_MODE=1`. The desktop
app runs unchanged without it: a single implicit owner holding every
permission, no database, no authentication. That is deliberate — there is no
privilege boundary to draw when the backend runs as the person who opened the
project.

### Enabling it

`mount_server_mode` ([apps/backend/server/integration.py](../apps/backend/server/integration.py))
fails **closed**: if server mode is requested and cannot initialize, the API
refuses to start rather than booting unauthenticated. See
[deploy/server-env.example](../deploy/server-env.example) for the full
environment file and [deploy/docker-compose.yml](../deploy/docker-compose.yml)
for a PostgreSQL-backed deployment.

The image (`deploy/Dockerfile.server`) installs `apps/backend/requirements.lock`, runs as the
unprivileged user `workpilot` (uid 10001: mount SSH keys under `/home/workpilot/.ssh`), and starts
through `deploy/server-entrypoint.sh`: `alembic upgrade head` first, and a failed migration stops
the container instead of serving. CI builds it and migrates a PostgreSQL 16 with it on every PR.

| Variable | Default | What it does |
|---|---|---|
| `WORKPILOT_SERVER_MODE` | `false` | Master switch. Everything in this section is inert without it. |
| `WORKPILOT_JWT_SECRET` | — | HS256 secret, **32 characters minimum**. A shorter or missing value aborts startup. |
| `WORKPILOT_DATABASE_URL` | local SQLite | `postgresql+asyncpg://…` in production. |
| `WORKPILOT_REPOS_ROOT` | `~/.workpilot/server-repos` | Where the server clones registered repositories — and, in server mode, the **only** directory tree a request can resolve a path inside. |
| `WORKPILOT_SECRETS_MASTER_KEY` | — | Fernet key encrypting per-user integration secrets. |
| `WORKPILOT_MAX_CONCURRENT_RUNS` | `3` | Deployment-wide ceiling. Per-organization ceilings are set in the console (see quotas below). |
| `WORKPILOT_RUN_ISOLATION` | `required` | Each run is confined by Landlock to its own clone, its project's home (`REPOS_ROOT/.run-homes/<project>`) and its own temp directory; other projects and the server's state are out of its reach. Needs Linux 5.13+ with Landlock enabled (Docker 23+ allows it) and a server that does not run as root. Where it cannot be enforced, runs fail with the reason. `off` runs them unconfined: only for a deployment where every user may read every project. See [server-mode.md](architecture/server-mode.md#ce-quun-run-voit-sur-le-disque). |
| `WORKPILOT_WS_URL` | `ws://127.0.0.1:8765` | Where the API pushes board events (projects, specs, runs) to the streaming WebSocket server. Change it only when that server is not on the API's loopback. |
| `WORKPILOT_GITLAB_HOSTS` | — | Self-hosted GitLab instances (comma-separated host names, e.g. `git.acme.test`) whose projects show their GitLab views, relayed with each person's own GitLab token. gitlab.com is always one. A project cloned from any other host shows none: its owner chose that URL, and a member's token is never sent to a host the operator did not name. |

Sign-in, invitations and email have their own variables, after
[Quotas](#quotas).

### Tenancy

An **organization** is the tenant. Users, projects, specs, runs, secrets and
audit entries all belong to one, and every query is scoped on `org_id`.

The organization a request acts in is resolved, in order: the
`X-WorkPilot-Org` header, the `org` claim of the access token, then the
caller's only membership when they have exactly one. **Both the header and the
claim are verified against membership on every request** — they select among
the organizations a user already belongs to, they never grant access. Several
memberships with no explicit choice is left unresolved rather than guessed.

Upgrading an existing single-tenant deployment is automatic: Alembic revision
`0003_multi_tenant` creates a "Default" organization, makes every existing user
a member with the role their old global role maps onto, and attributes every
existing project to it. Nobody loses access.

### Platform administrator vs. organization administrator

`users.role` is the **platform** role — what a user is to the deployment, not
to any tenant. `admin` there means the operator of the whole installation: they
can create and suspend organizations and reach into any tenant. That authority
is never grantable from inside an organization.

Business roles live in `org_members.role_id` and are scoped to one tenant.

### Permissions

The catalog lives in code, at
[apps/backend/server/authz/catalog.py](../apps/backend/server/authz/catalog.py),
not in the database: a permission the code does not implement cannot gate
anything, so a second copy could only drift. Keys are `<domain>.<action>` over
~17 domains (`task`, `agent`, `qa`, `vcs`, `analytics`, `ops`, `settings`,
`org`, `platform`…).

Permissions marked **privileged** are the ones whose blast radius exceeds the
data they touch — `agent.execute`, `settings.provider.write`, `project.delete`,
`org.role.write`, everything under `platform.` They are not granted by any
default role below administrator, and the console shows them apart.

Eight built-in roles (`owner`, `admin`, `maintainer`, `contributor`,
`reviewer`, `operator`, `analyst`, `viewer`) are seeded from
[server/authz/roles.py](../apps/backend/server/authz/roles.py) and are
read-only, so an upgrade that grants a new permission to `admin` reaches every
tenant. Organizations create custom roles instead; their permission list is
validated against the catalog on write.

**Effective permissions are resolved per request from the database, never
carried in the token.** An access token lives 15 minutes by default
(`WORKPILOT_ACCESS_TOKEN_TTL_MINUTES`); a permission removed from a role has to
bite on the next request, not a quarter of an hour later.

An organization can also switch permissions off wholesale — a licence tier or a
feature flag — through `disabled_permissions` in its settings, subtracted from
every member's effective set.

### Paths are no longer supplied by the client

The single-user API let a caller pass `project_dir`, an absolute filesystem
path, and read it. On a shared server that is a cross-tenant read and write, so
in server mode it is refused outright (HTTP 400) and callers identify a project
by `project_id`; the server resolves its own checkout. Two barriers enforce it:
the auth middleware rejects the key (`server.integration.CLIENT_PATH_PARAMS`)
in the query string and anywhere in the body — JSON at any depth, or form
fields — and `foundation.api_safety.validated_dir` confines resolution to
`WORKPILOT_REPOS_ROOT` when no allowed root is given, as a backstop.
`tests/backend/test_project_scope_coverage.py` walks every route's parameters
and body models, so a new path-taking field fails the build until it is either
refused or explicitly exempted with its reason.

### Live feed and agent runs

The streaming WebSocket server (`:8765`) has the same boundaries as the API. A
client connects to `/stream/project:<project_id>` (the board) or
`/stream/run:<run_id>` (one run's live feed) with `?token=<access token>`, and
optionally `&org=<org id>` to name the organization it acts in. The channel
opens only when the user has a role on that project in that organization;
`viewer` reads, `member` and above may also chat and pause. Any other channel
name is refused (close code `4403`), and so is a switch to a channel the user
may not open. Only the API and a run publish events; a run's token names that
run and opens nothing else.

A run starts with the server's environment **minus** every variable the server
reads for itself (signing key, secrets key, database, mail, Entra, repos root,
`POSTGRES_PASSWORD`), plus its own streaming token, the launching user's id and
that user's integration secrets. Provider credentials set for builds, such as
`CLAUDE_CODE_OAUTH_TOKEN`, are passed. A new server variable is classified in
[apps/backend/server/services/run_env.py](../apps/backend/server/services/run_env.py);
`tests/backend/test_run_env.py` fails until it is.

### Quotas

Per-organization ceilings on members, projects, concurrent runs and monthly
token budget, set in the console. **Absent means unlimited**, and an
organization with no quota row is unconstrained — so an upgraded deployment
behaves exactly as it did before quotas existed.

### Sign-in and sessions

The variables of this section and the next two are read once, on first use, by
[apps/backend/server/config.py](../apps/backend/server/config.py). A number that
does not parse is logged and replaced by its default. A boolean is true for
`1`, `true`, `yes` or `on`; set but empty, it is false.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_ACCESS_TOKEN_TTL_MINUTES` | 15 | Lifetime of an access token, also sent to clients as `expires_in`. |
| `WORKPILOT_REFRESH_TOKEN_TTL_DAYS` | 14 | Lifetime of a sign-in session (refresh token) before the user signs in again. |
| `WORKPILOT_JWT_ISSUER` | `workpilot` | `iss` claim written into, and required on, every token the server issues. The API and the WebSocket server must agree on it; changing it invalidates the access tokens in flight. |
| `WORKPILOT_ENTRA_TENANT_ID` | — | Microsoft Entra ID directory (tenant) whose keys and issuer sign-in tokens are checked against. |
| `WORKPILOT_ENTRA_CLIENT_ID` | — | Application (client) ID of the Entra app registration, checked as the token audience. |

Entra sign-in is on only when both Entra variables are set; local accounts work
either way. Neither identifier is a secret: `GET /auth/config` hands both to the
sign-in page.

### Invitations and local passwords

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_PUBLIC_BASE_URL` | — | Public URL of the server, the base of invitation links (`<url>/invite?token=…`). Without it the link is relative and the administrator completes it. |
| `WORKPILOT_PUBLIC_STREAM_URL` | — | Where the desktop app opens a board's live stream (`ws://` or `wss://`), when it is not the API's host on port 8765, e.g. behind a TLS reverse proxy. Anything else is ignored. |
| `WORKPILOT_INVITATION_TTL_HOURS` | 72 | How long an invitation link stays usable. |
| `WORKPILOT_PASSWORD_MIN_LENGTH` | 12 | Minimum length of a local password. It can only raise the floor: a value below 12 keeps 12. |
| `WORKPILOT_PASSWORD_HIBP_CHECK` | `false` | Refuses a new local password found in Have I Been Pwned. Only the first five hex characters of its SHA-1 leave the server; when the service cannot be reached, the password is accepted. |
| `WORKPILOT_ADMIN_PASSWORD` | — | Password of the first administrator, read by `python -m server.scripts.create_admin <email>` (run from `apps/backend`) instead of prompting. Remove it from the environment once the account exists. |

### Invitation email (SMTP)

Invitation emails go out only when both `WORKPILOT_SMTP_HOST` and
`WORKPILOT_SMTP_FROM` are set. Otherwise, or when sending fails, the API returns
the link for the administrator to pass on.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_SMTP_HOST` | — | SMTP server. |
| `WORKPILOT_SMTP_PORT` | 587 | SMTP port. It does not follow `WORKPILOT_SMTP_USE_SSL`: set 465 yourself. |
| `WORKPILOT_SMTP_USER` | — | SMTP login; no authentication when empty. |
| `WORKPILOT_SMTP_PASSWORD` | — | SMTP password, used only with a login. A secret: keep it out of tracked files. |
| `WORKPILOT_SMTP_FROM` | — | `From:` address of the emails. |
| `WORKPILOT_SMTP_USE_TLS` | `true` | Upgrades the connection with STARTTLS. Ignored when `WORKPILOT_SMTP_USE_SSL` is on. |
| `WORKPILOT_SMTP_USE_SSL` | `false` | TLS from the first byte (port 465). |

Keep one of the two TLS options on: with both off, the email and the SMTP
credentials travel in clear text.

---

## Where environment variables are read from

The desktop app and the CLI do not read the same files. A variable already set
in the environment a process starts with is never overwritten by a file it
loads.

- **The CLI** (`run.py`) loads `.env-files/.env` at the WorkPilot root.
- **The desktop app** loads `.env-files/.env` into its own environment when it
  starts. The local API (`127.0.0.1:9000`) and the streaming WebSocket server
  (`:8765`) inherit that environment as is.
- **A task the app runs** (spec, planning, coding, QA) gets that environment,
  overlaid in this order, later winning: `apps/backend/.env`, the project's
  `.workpilot/.env` (written by Project settings), then the Claude profile and
  provider credentials the app derives from Settings. A value set in Settings
  therefore beats the same variable set by hand.
- The local API never reads a project's `.workpilot/.env`: a variable read by an
  API route belongs in `.env-files/.env`.

Most variables are read when the process that uses them starts; restart the app,
or re-run the task, after changing one.

## Local API, WebSocket server and data at rest

These apply with or without server mode.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_EXTRA_CORS_ORIGINS` | — | Comma-separated origins added to the local API's built-in localhost and Electron list, with credentials allowed. Never `*`: with credentials allowed, it lets any origin in. |
| `WORKPILOT_WS_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,file://` | Comma-separated browser origins allowed to open the streaming WebSocket. It replaces the default list, entries are not trimmed: write them without spaces. |
| `AUDIT_TRAIL_ALLOWED_ROOTS` | — | Desktop mode: directories, separated by `:` (`;` on Windows), under which the audit-trail panel may keep a project's trail (`<project>/.workpilot/audit-trail`); a directory outside them is refused. Unset, any directory is accepted. In server mode a client cannot name a directory at all (see [Paths are no longer supplied by the client](#paths-are-no-longer-supplied-by-the-client)). |
| `AUDIT_TRAIL_FERNET_KEY` | — | Fernet key encrypting each new audit-trail line on disk; lines written before stay readable. Every process that writes trails needs it: the API and the build agents. There is one key and no rotation: changing it makes the lines encrypted with the old one unreadable. |
| `VALIDATED_KEYS_FERNET_KEY` | — | Fernet key encrypting the hashes of provider API keys already checked (`validated_keys.sqlite3`). |
| `VALIDATED_KEYS_TTL_DAYS` | 30 | Days after which a provider key counts as unchecked and is validated again. Minimum 1. |
| `ANALYTICS_DATABASE_URL` | `sqlite:///<WorkPilot root>/data/analytics.db` | SQLAlchemy URL of the build-analytics database (dashboard, estimates, agent health), written by the builds. The engine is synchronous: a URL other than SQLite needs a synchronous driver installed. |

Both Fernet keys are secrets. Check the backend log after setting one: a key
that is not a valid Fernet key is reported there, and the data is then written
unencrypted.

### Repo bench

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_DATA_DIR` | `~/.workpilot` | Where the repo bench keeps its isolated copies and logs (`<dir>/bench/<project key>/<run>/`), outside the project checkout. Also the hooks data directory. |
| `WORKPILOT_BENCH_JUDGE_TIMEOUT` | 900 | Seconds a judge run (one test suite on one copy) may take before its whole process tree is stopped; the tests it did not report count as failed. Calibration uses the same limit. |
| `WORKPILOT_BENCH_CONCURRENCY` | 2 | Bench builds running at once, at most 4. Each is a full task billed by its provider. |

A project the judge detection does not cover declares its test command in
`.workpilot/bench.json` (see [repo-bench.md](architecture/repo-bench.md)).

---

## Mock / stub behaviors to be aware of

A few connectors currently fall back to deterministic stubs when their
real integration is not configured. They **log a warning** when this path
is taken so the user knows the output is not live data:

- **Bounty board** — contestants fall back to a `[stub:...]` output string
  when the `llm_client` module is not importable. Logs a warning per
  contestant.
- **Analytics API** ([apps/backend/analytics/api_minimal.py](../apps/backend/analytics/api_minimal.py))
  currently returns empty/mock payloads for every endpoint. Treat it as a
  scaffold until a real database-backed implementation lands.

## QA validation loop

The QA loop ([apps/backend/qa/](../apps/backend/qa/)) reads these from the backend process
environment; the build CLI also loads `.env-files/.env`, where a value already set in the
environment wins:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_QA_MAX_ITERATIONS` | by effort | Review passes a task may run, whatever its QA effort. Capped at 50; a value below 1 or that is not a number is ignored. |
| `WORKPILOT_QA_RECURRING_THRESHOLD` | 8 | Occurrences of the same issue, across passes, that make QA escalate to a human. Bounded by the budget; a value below 2 or that is not a number falls back to 8. |
| `WORKPILOT_QA_LIGHT` | 1 | `0` reviews every task in full, text-only changes included (see *Text-only changes* below). |
| `WORKPILOT_QA_MIN_COVERAGE` | 100 | Minimum coverage, in percent, of the `unit` **and** `integration` tests; `e2e` below it only warns. `0` disables the gate. Clamped to 0–100; a value that is not a number falls back to 100. |

### Review budget

Without `WORKPILOT_QA_MAX_ITERATIONS`, the budget
([apps/backend/qa/budget.py](../apps/backend/qa/budget.py)) follows the effort of the
task's QA phase (`phaseThinking.qa`, `high` by default): 3 passes at `none`, 5 at `low`,
8 at `medium`, 12 at `high`, 20 at `ultrathink`; an unknown effort gets 12. The budget
belongs to the task: a build paused and resumed in the middle of QA continues its count,
and feedback a person writes opens a new budget. A task that spends its budget without
approval lands in human review, flagged with errors.

An issue reported `WORKPILOT_QA_RECURRING_THRESHOLD` times, counting the current pass and
the earlier ones (the same issue, or one similar enough), escalates to a human with a
`QA_ESCALATION.md` instead of another fix. The threshold never exceeds the budget, so the
escalation stays reachable at every effort: at `none`, 3 occurrences are enough. Issues the
fixer cannot act on, such as "requires manual verification" or "cannot verify without
runtime", never count toward it.

### Coverage gate

Once the QA reviewer approves a pass, the coverage gate
([apps/backend/qa/coverage_gate.py](../apps/backend/qa/coverage_gate.py)) checks the
percentages the reviewer recorded in `implementation_plan.json` → `qa_signoff.coverage`
against `WORKPILOT_QA_MIN_COVERAGE`.

A pass below the threshold, or whose coverage the reviewer did not measure (no value, or
`measured: false`), is rejected: the QA fixer receives a `QA_FIX_REQUEST.md` listing the
gaps, then a new review runs, within the task's QA budget. A project without integration
tests never passes at 100: lower the threshold or set it to `0`. The same value is written
into the spec writer, planner, QA reviewer and QA fixer prompts, so the agents aim at the
threshold the gate enforces.

### Text-only changes

Before each review pass, the loop reads the task's change set from git
([apps/backend/foundation/change_scope.py](../apps/backend/foundation/change_scope.py)):
committed, uncommitted and untracked files since the base branch. When every changed file is
plain text or documentation (`.txt`, `.md`, `.rst`, `.adoc`, README, LICENSE…), at most
10 files and 400 changed lines, the pass is a **light review**: the reviewer gets the spec and
the diff inline (`prompts/qa_reviewer_light.md`) and checks the change against the acceptance
criteria, without the dev environment, the test suites, coverage, repository scans, the
subagent roster or the project memory. The coverage gate does not apply: no source file
changed. JSON, YAML, TOML, XML, `.env`, project files and scripts are read by a program and
always get the full review, and so does a change set git cannot read. The decision is made
from git and file names only, so it is the same for every provider and model. With strict TDD
on, a subtask whose files are all text-only is not run as a red-green-refactor cycle either.

## Verification loop (`verify`)

The runtime verification phase (`apps/backend/verify/`, see
[architecture/verify.md](architecture/verify.md#verification-loop-verify)) reads these from
the backend environment, then from `.workpilot/.env`:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `VERIFY_ENABLED` | `true` | Master switch. The project setting "Verification loop" writes `false`. |
| `WORKPILOT_VERIFY_LOOP` | — | Per-task override (`true`/`false`), sent by the Kanban. |
| `VERIFY_MAX_ROUNDS` | 5 | Ceiling on launch → fix rounds; the loop also stops after two rounds without progress. |
| `VERIFY_LAUNCH_TIMEOUT` | 120 | Seconds to wait for the launched app to answer. |
| `VERIFY_PERF_TRACE` | `true` | Chrome DevTools performance trace and Lighthouse audit. |
| `VERIFY_ALLOW_MUTATIONS` | `true` | Call mutating endpoints (POST/PUT/PATCH/DELETE) on the dev server the loop launched. |
| `VERIFY_PERF_REGRESSION` | 10 | Score drop, in points, against the per-route baseline reported as a regression. |
| `VERIFY_BROWSER` | `auto` | `auto` (chrome-devtools-mcp, then Playwright), `devtools`, `playwright`, `off`. |
| `VERIFY_CHROME_PATH` | — | A specific Chrome/Chromium binary. |
| `CHROME_PATH` | — | Same, read when `VERIFY_CHROME_PATH` is unset. A path that is not an existing file is ignored. |

## OS sandbox (`os_sandbox`)

Agent commands run under bubblewrap (Linux) or Seatbelt (macOS), see
[architecture/os-sandbox.md](architecture/os-sandbox.md). Read from the backend environment:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_SANDBOX` | `auto` | `auto`: sandboxed when the machine can, otherwise the build runs and its card says commands are not isolated. `required`: a build that cannot be sandboxed does not start. `off`: never sandboxed (the card says so). |
| `WORKPILOT_SANDBOX_HOSTS` | — | Extra hosts a sandboxed process may reach, comma separated: `nexus.corp.example`, `*.corp.example` (subdomains only), `127.0.0.1:5000` (a local port). Remote hosts open 443 and 80 only. |

On Ubuntu 24.04 and later, unprivileged user namespaces are restricted by AppArmor and bubblewrap
fails; the card says so. `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` (or an
AppArmor profile for `bwrap`) lifts it. Claude Code's own sandbox on Linux also needs `socat`: when
it is missing, the Claude provider's commands run without isolation and the task feed shows
`Sandbox (claude): commands are NOT isolated: … socat … install it with …`. On Debian, Ubuntu or
WSL: `sudo apt install bubblewrap socat`, then start the task again. The reason line names the
command of the package manager found on the machine (apt, dnf, pacman, zypper, apk).

## RUN tasks — `.workpilot/environments.toml`

A card of kind `run` (an operation on something that runs: restart, purge, migrate data,
deploy, rotate) plays a procedure a model wrote and a person read
([architecture/kanban-task-types.md](architecture/kanban-task-types.md), lot 3). Where it may
act is declared in the project, in `<project>/.workpilot/environments.toml`:

```toml
[environments.staging]
description = "the staging stack"
health = ["curl -fsS https://staging.example.test/healthz"]
variables = ["STAGING_DB_URL", "STAGING_API_TOKEN"]
```

| Key | Meaning |
| --- | --- |
| `health` | Commands run before the first step; one that fails stops the run. Through the project's command allowlist like every step. |
| `variables` | The **names** of the variables the steps read. Their values live in the operator's environment (or the project's `.env` vault) and reach the step's process only; they are never read by the model, printed, or written to the journal. A value in this file is refused. |

Without the file, a RUN runs only in the task's worktree. A procedure that names an environment
the project did not declare is blocked, not redirected: the operator who wrote
`Environnement : production` meant production.

What the execution writes, in the spec's `workflow/` directory: `run.md` (the journal — each
command, its exit code, its output cut to a page with secrets masked), `run-state.json`
(status and the next step, so a failed run resumes where it stopped), `procedure.frozen.json`
(the procedure being played is never rewritten by a model), `execute.pause.json` (present
until the person resumes the build that stopped before the irreversible phase).

## Local and OpenAI-compatible endpoints

The `ollama` provider talks to Ollama's native API; `lm-studio` and `llama-cpp`
use their OpenAI-compatible one. The desktop app sets `OLLAMA_BASE_URL` and
`OLLAMA_MODEL` from Settings; set them by hand for the CLI.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server. In offline mode it is the only URL variable the `ollama` provider reads. |
| `LOCAL_LLM_BASE_URL` | — | Same, read when `OLLAMA_BASE_URL` is unset; it must point at an Ollama server. |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234` | LM Studio server. It must be a loopback address, offline mode or not. Also the last fallback for the Ollama URL. |
| `LLAMA_CPP_BASE_URL` | `http://127.0.0.1:8080` | llama.cpp server. It must be a loopback address, offline mode or not. |
| `OLLAMA_MODEL` | registry default for Ollama | Model a local provider runs when no valid model was selected, or when a model only a hosted provider serves reaches it. |
| `LOCAL_LLM_MODEL` | — | Same, read when `OLLAMA_MODEL` is unset. |
| `OLLAMA_API_KEY`, `LOCAL_LLM_API_KEY`, `LMSTUDIO_API_KEY` | — | Bearer token for an LM Studio or llama.cpp server that requires one, read in this order. Ollama's native API is sent no token. Secrets. |

## Local generation deadlines

Requests to local models have these limits, in seconds, configured in the
backend process environment. `LOCAL_LLM_REQUEST_TIMEOUT` also caps LM Studio and
llama.cpp requests; the other two apply to Ollama's native chat only:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `LOCAL_LLM_REQUEST_TIMEOUT` | 600 | Maximum duration of one chat request, including continuous slow output. |
| `LOCAL_LLM_INITIAL_OUTPUT_TIMEOUT` | 300 | Maximum wait before any output; also applies to the non-streaming fallback. |
| `LOCAL_LLM_GENERATION_IDLE_TIMEOUT` | 120 | Maximum silence after streamed output begins. |

The heartbeat checks silence every 30 seconds. On a deadline, transport error or truncated response, the request is cancelled and spec creation fails explicitly without retrying the same failing generation. Connection-establishment retries remain bounded. These limits do not make an oversized model faster: use a model that fits the available hardware. Raise them only deliberately for a known slow workload.

In-flight progress counts received **fragments**, not tokenizer tokens. Exact output token usage comes from Ollama's final `eval_count`; a fragment may contain multiple tokens, and tool arguments can be buffered by the server.

`OLLAMA_STREAM` (default `true`) streams each Ollama turn; `false`, `0`, `no` or
`off` sends one non-streaming request per turn, without the fragment counter. The
client also falls back to a non-streaming request on its own when the server
rejects a streamed tool-calling turn.

## Claude Agent SDK sessions

Read by every Claude session WorkPilot starts through `create_client()` (spec,
planner, coder, QA…).

| Variable | Default | Meaning |
| --- | ---: | --- |
| `AUTO_CLAUDE_MAX_TURNS` | 1000 | Maximum agent turns in one session. A value that is not an integer stops the session from starting. |
| `AUTO_CLAUDE_MAX_BUDGET_USD` | 5.0 | Spending cap, in US dollars, of one session — not of the task — on every provider. Past it the session ends (the Claude SDK ends it itself; for the other providers the session runner does, from each call's measured usage and the model's price in `cost_intelligence/catalog.py`) and the Kanban offers to resume. A model without a known price is not capped. 0 or less removes the cap; a value that is not a number falls back to 5.0. |
| `AUTO_CLAUDE_EFFORT` | the phase's thinking level | Forces the SDK `effort` level (`low`, `medium`, `high`, `xhigh`, `max`) of sessions on an Opus model; other models ignore it. Without it, the effort follows the thinking level the user chose for the phase: `none` and `low` → `low`, `medium` → `medium`, `high` → `high`, `ultrathink` → `xhigh`. Opus 5.5 takes no thinking budget, so this is its only reasoning control. |
| `AUTO_CLAUDE_OTEL_ENDPOINT` | — | OTLP endpoint, such as `http://localhost:4318`. When set, each session exports traces, metrics and logs over OTLP `http/protobuf` as the service `workpilot-<agent type>`, and these settings replace any `OTEL_*` variable of the same name. It also turns on WorkPilot's own GenAI spans for every provider (`invoke_agent`, `chat`, `execute_tool`; no prompt or output), sent to `<endpoint>/v1/traces` as the service `workpilot`, with any key read from `OTEL_EXPORTER_OTLP_HEADERS` ([genai-traces.md](architecture/genai-traces.md)). Point it only at a collector you control. |
| `AUTO_CLAUDE_AGENT_DEBUGGER` | off | `1`, `true`, `yes` or `on` attaches the Agent Debugger's breakpoints to every session, even when the debugger was not opened for that task. |
| `CLAUDE_CLI_PATH` | the SDK's bundled CLI | `claude` executable the SDK launches. Ignored when it is not an existing file or holds shell metacharacters, `..` or a variable reference. The desktop app sets it from detection or the Claude path setting. |
| `CLAUDE_CODE_GIT_BASH_PATH` | detected | Windows only: the Git for Windows `bash.exe` the Claude Code CLI needs; WorkPilot also looks for `git.exe` next to it. The desktop app sets it when it finds one. |

## Provider selection and endpoints

The desktop app writes these from Settings into each task's environment (see
[Where environment variables are read from](#where-environment-variables-are-read-from)):
setting them by hand matters mainly for the CLI and headless runs.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `AUTO_CLAUDE_PROVIDER` | — | Default provider when nothing more specific names one: a task's own engine, the provider picked in the UI, `SELECTED_LLM_PROVIDER` and `task_metadata.json` all win over it. Accepted: `claude`, `copilot`, `openai`, `google`, `gemini`, `ollama`, `meta`, `mistral`, `deepseek`, `grok`, `aws`, `windsurf`, `cursor`, `custom`, `opencode`, `antigravity`, `agy`, `pi`, `gemini-cli`. Any other value, `anthropic` included, is ignored. |
| `WORKPILOT_PI_MODE` | `json` | `rpc` keeps one pi process per session (`compact` on demand, `abort` on cancel, the model's context window read from `get_state`); `json` starts one per turn. Any other value is `json`. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Where pi keeps `trust.json`, `mcp.json` and `models.json`; read by the pi provider and by `brain connect`. The provider sets `PI_CODING_AGENT_SESSION_DIR` (the task's `<spec>/pi-sessions`) and `PI_SKIP_VERSION_CHECK=1` on the pi subprocess itself. Guide: [`integrations/pi.md`](integrations/pi.md). |
| `GEMINI_API_KEY` | — | Read only by the `gemini-cli` (ACP) provider, to sign Gemini CLI in with its `gemini-api-key` method when a session asks for a login; otherwise sign in once with `gemini`. Guide: [`architecture/acp.md`](architecture/acp.md). |
| `WORKPILOT_PERMISSION_TIMEOUT_SECONDS` | 1800 | How long an ACP agent's question waits on the card (or in the terminal) before it is refused. A value that is not a positive number is the default. |
| `WORKPILOT_PERMISSION_CHANNEL` | — | Set to `stdin` by the app for a task process: an ACP agent's questions go to the card. Not for hand use; without it a terminal run asks in the terminal, and any other run refuses. |
| `OPENAI_AUTH_MODE` | `api-key` | `codex-cli` runs OpenAI sessions through the logged-in Codex CLI instead of the API key. A model only the API serves still goes to the API when a key is configured. |
| `GOOGLE_API_KEY` | — | Gemini API key of the `google` and `gemini` providers; their agent sessions read no other source. Secret. |
| `MISTRAL_BASE_URL` | `https://api.mistral.ai` | Mistral API base, with or without `/v1`. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Same, for DeepSeek. |
| `GROK_BASE_URL` | `https://api.x.ai` | Same, for xAI Grok. |

For the three base URLs, agent sessions prefer the variable to the URL saved in
the provider configuration; the model list does the opposite.

The `meta`, `aws` and `cursor` providers have no adapter of their own: their
credentials only feed the provider status, and their builds run on Claude.

### Windsurf

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WINDSURF_API_KEY` | — | Windsurf credential, read first. With none of the three set, WorkPilot reads the key of the installed Windsurf IDE. An `sk-ws-` key is replaced by a different one found in the IDE's state, taken as newer. Secret. |
| `WINDSURF_OAUTH_TOKEN` | — | Read second; also what the provider status checks. Secret. |
| `CODEIUM_API_KEY` | — | Read third, the legacy name. Secret. |
| `WINDSURF_BASE_URL` | probed | Pins the Windsurf REST base, an enterprise endpoint for example, and turns off probing. |

## GitHub Copilot client

Read once when the backend starts. A value that is not a number is logged and
replaced by its default.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `COPILOT_REQUEST_TOTAL_TIMEOUT` | 600 | Ceiling, in seconds, on one chat request. |
| `COPILOT_REQUEST_CONNECT_TIMEOUT` | 20 | Seconds to open the connection. |
| `COPILOT_REQUEST_SOCK_READ_TIMEOUT` | 540 | Longest silence, in seconds, between two reads. Replies are not streamed, so it is in practice how long the model may take to answer. |
| `COPILOT_TIMEOUT_MAX_RETRIES` | 2 | Retries of a request that timed out before the turn fails. |
| `COPILOT_RATE_LIMIT_MAX_RETRIES` | 6 | Retries on HTTP 429, 500, 502, 503 or 529 before the error surfaces. |
| `COPILOT_RATE_LIMIT_BACKOFF` | 5 | Base wait, in seconds, when the server sends no `Retry-After`; it doubles at each attempt. |
| `COPILOT_RATE_LIMIT_MAX_BACKOFF` | 60 | Cap, in seconds, on one wait, `Retry-After` included. |
| `COPILOT_MAX_CONSECUTIVE_EMPTY_RESPONSES` | 4 | Successive empty replies resent before the session gives up. |
| `COPILOT_EMPTY_RESPONSE_BACKOFF` | 2 | Base wait, in seconds, before resending an empty reply; it grows with each one. |

## Non-Claude agent context and tools

The first three variables apply to the agent clients WorkPilot drives itself:
OpenAI with an API key, Gemini, Mistral, DeepSeek, Grok, the local providers,
Copilot and Windsurf. Claude sessions and the CLI-based clients (Codex CLI,
OpenCode, Antigravity, pi) are not affected.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `LLM_TOOL_RESULT_MAX_CHARS` | 10000 | Characters of one tool result kept in the conversation (minimum 1000); the cut keeps the start and the end. `read_file`, `search_files` and `find_files` page under it instead, and say which offset reads on, so nothing is cut from them; a longer `run_command` output is written, secrets masked, to `<spec>/tool-output/` and the model reads its head, its tail and the offset of the rest. On Ollama it is also capped from the model's context length. |
| `LLM_HISTORY_CHAR_BUDGET` | 300000 | Conversation size, in characters (minimum 50000), counting the arguments of tool calls, above which the oldest tool results, and the long arguments of old tool calls (a whole file handed to a write), are replaced by a placeholder, in one batch down to 60% of it (and only when that frees at least a tenth of it), so the next turns do not rewrite the cached prefix again. The system prompt, the first request and the last eight messages are always kept. Also capped on Ollama. |
| `LOCAL_COMMAND_TIMEOUT` | 120 | Seconds before a shell command run by the agent is killed. Despite its name, not limited to local models. Must be a positive number. |
| `LLM_INLINE_FILE_CONTEXT` | `auto` | Whether the coder's prompt includes excerpts of the files to modify and of the pattern files: `auto` for providers other than Claude at effort `none`, `low` or `medium`; `always` for every provider, Claude included; `never` for none. |

## Code search

`search_code` returns ranked excerpts of the project's code to the agent types
that declare it, on every provider: over the `workpilot-code` MCP server on
Claude, in-process on the others
([context harness, lot 7](architecture/context-harness.md)). It reads only the
project's files that git does not ignore, masks secrets in what it returns, and
uses no network.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `CODE_SEARCH_RESULTS` | 6 | Excerpts a call returns when the model asks for no number. |
| `CODE_SEARCH_MAX_RESULTS` | 8 | The most excerpts one call may return (at most 20). |
| `WORKPILOT_CODE_ROOT` | the working directory | The project the `workpilot-code` server answers for when it is started without `--project-dir`. |

## Auxiliary models

| Variable | Default | Meaning |
| --- | ---: | --- |
| `UTILITY_MODEL_ID` | `DEFAULT_UTILITY_MODEL` ([foundation/model_config.py](../apps/backend/foundation/model_config.py)) | Model of the utility calls: the AI merge resolver and, when a pull request is created, the template filler and the impact analysis. The desktop app sets it for merges from the utility model in Settings. |
| `UTILITY_THINKING_BUDGET` | off | Thinking budget, in tokens, of the same calls; empty or `0` turns it off. The desktop app sets it for merges. |
| `INSIGHT_EXTRACTION_ENABLED` | `true` | After each coder session, an LLM pass extracts insights into the project memory. Only `true`, `1` or `yes` keep it on (`on` turns it off). It also needs a Claude token. |
| `INSIGHT_EXTRACTOR_MODEL` | `DEFAULT_EXTRACTION_MODEL` ([analysis/insight_extractor.py](../apps/backend/analysis/insight_extractor.py)) | Model of that pass. It always runs on Claude: give a Claude model id. |

## Forges, notifications and MCP servers

### Forges

Project settings writes `GITHUB_REPO` and `GITLAB_PROJECT` into the project's
`.workpilot/.env`.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `GITHUB_REPO` | detected | The project's `owner/repo`, for the GitHub views, the CI loop and the GitHub runner when it cannot detect it. |
| `GITLAB_PROJECT` | — | The project's `group/project`, for the same uses on GitLab. |
| `AZURE_DEVOPS_EXT_PAT` | — | Read when `AZURE_DEVOPS_PAT` is unset (it is the Azure DevOps CLI's name for it): pushes a task branch and opens its pull request. Secret. |
| `GITHUB_BOT_TOKEN` | — | Token of the GitHub automation runner's bot account (PR review, auto-fix, triage) when `--bot-token` is not given. It only identifies that account, so the runner skips what the bot wrote itself; nothing is posted with it. Secret. |
| `MAX_PR_WORKTREES` | 10 | PR-review worktrees kept in `.workpilot/github/pr/worktrees`; the oldest go beyond that. |
| `PR_WORKTREE_MAX_AGE_DAYS` | 7 | Age, in days, past which a PR-review worktree is removed, checked before each new review. `0` removes them all. |

### Notifications

When WorkPilot opens a task's pull request, it posts to every enabled channel.
A channel needs its switch set to `true` and a webhook URL. The process
environment wins over the project's `.workpilot/.env`, which Project settings >
Notifications writes. A webhook URL is a credential: keep it out of tracked
files. Only public `http` and `https` addresses are accepted.

| Channel | Switch | Webhook URL |
| --- | --- | --- |
| Microsoft Teams | `TEAMS_NOTIFICATIONS_ENABLED` | `TEAMS_WEBHOOK_URL` |
| Slack | `SLACK_NOTIFICATIONS_ENABLED` | `SLACK_WEBHOOK_URL` |
| Discord | `DISCORD_NOTIFICATIONS_ENABLED` | `DISCORD_WEBHOOK_URL` |
| Google Chat | `GOOGLE_CHAT_NOTIFICATIONS_ENABLED` | `GOOGLE_CHAT_WEBHOOK_URL` |
| Generic webhook | `NOTIFY_WEBHOOK_ENABLED` | `NOTIFY_WEBHOOK_URL` |

`SLACK_WEBHOOK_URL` and `TEAMS_WEBHOOK_URL` are also where a hook's `send_slack`
or `send_teams` action posts when it names no URL.

### Third-party MCP servers

These credentials go only to an MCP server an agent may be given. A server starts
when the project adds it to an agent (`AGENT_MCP_<agent>_ADD`, written by the
agent tools screen) and its variables are set; otherwise it is skipped without a
message. WorkPilot's own integrations read other names, in the last column.

| Server | Variables | WorkPilot's own integration reads |
| --- | --- | --- |
| `github` | `GITHUB_PERSONAL_ACCESS_TOKEN` | `GITHUB_TOKEN`, or the `gh` CLI |
| `brave-search` | `BRAVE_API_KEY` | — |
| `jira` | `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN` | `JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| `azure-devops` | `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_TOKEN` | `AZURE_DEVOPS_ORG_URL`, `AZURE_DEVOPS_PAT` |
| `sentry` | `SENTRY_AUTH_TOKEN` | — (error reporting uses `SENTRY_DSN`) |
| `slack` | `SLACK_BOT_TOKEN` | — |
| `postman` | `POSTMAN_API_KEY` | — |
| `teams` | `TEAMS_WEBHOOK_URL` | the same, for notifications |

### MCP tasks (2026-07-28)

A server may return a tool call as a task (`io.modelcontextprotocol/tasks`); the
providers on WorkPilot's own loop wait for it, see
[architecture/mcp-2026.md](architecture/mcp-2026.md).

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_MCP_TASK_TIMEOUT` | 1800 | Seconds a tool call returned as a task may run before WorkPilot cancels it (`tasks/cancel`) and gives the agent an error that says so. A value that is not a positive number keeps the default. |

## Agent features

Opt-in features. Those marked *API* are read by the local API: put them in
`.env-files/.env`.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `WORKPILOT_LOOP_DETECTION_ENABLED` | off | `1`, `true`, `yes` or `on`: from the coder's second iteration, a diff that repeats one of the last four pauses the build, with the event in the audit trail. It resumes like any paused build. |
| `WORKPILOT_AUTO_PROMOTE_THRESHOLD` | off | *API.* Integer from 0 to 100. Enables "Accept & skip human review" in the QA promotion dialog when the build's QA score reaches it; the score is 0 unless QA signed off. Nothing moves a card on its own. |
| `AUTO_TEST_GENERATION` | on | `false`, and only `false`, removes the "automated tests" section from each subtask's coding prompt. That section tells the coder which kinds of tests to write, with the test libraries the project already has. |
| `AUTO_FIX_MAX_ATTEMPTS` | 5 | CLI: attempts of `run.py --spec … --auto-fix` when `--auto-fix-max-attempts` is not given. |

## Debug and console output

| Variable | Default | Meaning |
| --- | ---: | --- |
| `DEBUG_LEVEL` | 1 | With `DEBUG` on (see [CLI-USAGE.md](CLI-USAGE.md)): `1` basic messages, `2` adds the detailed ones, `3` the verbose ones. |
| `ENABLE_FANCY_UI` | `true` | Any value other than `true`, `1`, `yes` or `on` turns off Unicode symbols, colours and interactive menus in the backend CLI. |
