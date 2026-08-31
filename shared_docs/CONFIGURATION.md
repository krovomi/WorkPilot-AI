# Configuration

This document is the single reference for how WorkPilot AI loads its runtime
configuration. It covers:

1. The LLM provider registry (`configured_providers.json`).
2. The per-user provider configurations (`~/.work_pilot_ai_llm_providers.json`).
3. The authentication token resolution order.
4. Multi-user server mode: tenants, roles and permissions.

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
- **Frontend TypeScript** — a typed module is **generated** from the JSON
  at [apps/frontend/src/shared/types/providers.generated.ts](../apps/frontend/src/shared/types/providers.generated.ts).
  It exposes `ConfiguredProvider`, `ProviderName` (union of every known
  ID), `CONFIGURED_PROVIDERS`, and `isProviderName()` as a type guard.

**Regenerate after editing the JSON:**

```bash
pnpm run generate:provider-types
```

**CI check** — fails if the generated file drifts from the JSON:

```bash
pnpm run validate:provider-types
```

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
overrides) and the currently **active** provider. Managed from the CLI:

```bash
# List providers (the active one is marked "(actif)")
python -m apps.backend.cli provider list

# Select the active provider (persisted)
python -m apps.backend.cli provider select --provider openai

# Save a provider configuration
python -m apps.backend.cli provider add \
    --provider openai \
    --config '{"api_key":"sk-...","model":"gpt-4o"}'

# Test a provider
python -m apps.backend.cli provider test --provider openai

# Delete a provider's saved config
python -m apps.backend.cli provider delete --provider openai
```

Internally, the active provider is stored under the reserved key
`__active_provider__`. That key is filtered out of `list_provider_configs()`,
so it never appears as a "configured provider" in the UI.

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

### Deliberately **not** supported

- **`ANTHROPIC_API_KEY`** is intentionally excluded. Supporting it could
  silently bill the user's API credits if the OAuth path misconfigures —
  a failure mode we've explicitly ruled out.

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

| Variable | Default | What it does |
|---|---|---|
| `WORKPILOT_SERVER_MODE` | `false` | Master switch. Everything in this section is inert without it. |
| `WORKPILOT_JWT_SECRET` | — | HS256 secret, **32 characters minimum**. A shorter or missing value aborts startup. |
| `WORKPILOT_DATABASE_URL` | local SQLite | `postgresql+asyncpg://…` in production. |
| `WORKPILOT_REPOS_ROOT` | `~/.workpilot/server-repos` | Where the server clones registered repositories — and, in server mode, the **only** directory tree a request can resolve a path inside. |
| `WORKPILOT_SECRETS_MASTER_KEY` | — | Fernet key encrypting per-user integration secrets. |
| `WORKPILOT_MAX_CONCURRENT_RUNS` | `3` | Deployment-wide ceiling. Per-organization ceilings are set in the console (see quotas below). |

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
carried in the token.** A token lives 15 minutes; a permission removed from a
role has to bite on the next request, not a quarter of an hour later.

An organization can also switch permissions off wholesale — a licence tier or a
feature flag — through `disabled_permissions` in its settings, subtracted from
every member's effective set.

### Paths are no longer supplied by the client

The single-user API let a caller pass `project_dir`, an absolute filesystem
path, and read it. On a shared server that is a cross-tenant read and write, so
in server mode it is refused outright (HTTP 400) and callers identify a project
by `project_id`; the server resolves its own checkout. Two barriers enforce it:
the auth middleware rejects the parameter in a query string, and
`core.api_safety.validated_dir` confines resolution to `WORKPILOT_REPOS_ROOT`
when no allowed root is given — which also covers the endpoints that read a
path out of a JSON body.

### Quotas

Per-organization ceilings on members, projects, concurrent runs and monthly
token budget, set in the console. **Absent means unlimited**, and an
organization with no quota row is unconstrained — so an upgraded deployment
behaves exactly as it did before quotas existed.

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
