# OpenAI Codex CLI authentication

## Context

WorkPilot exposes two OpenAI authentication tabs: an API key tab and an
`OAuth / Codex` tab. The OAuth tab currently displays a warning that Codex CLI
credentials cannot be used, even though the frontend already knows how to
launch a Codex authentication terminal and detect `~/.codex/auth.json`.

The backend has only one OpenAI execution path. `OpenAIAgentClient` calls the
OpenAI API directly and therefore requires `OPENAI_API_KEY`. Passing a ChatGPT
OAuth access token to this client would be incorrect and would couple WorkPilot
to private credential details.

Codex CLI supports ChatGPT subscription authentication and exposes a documented
non-interactive interface through `codex exec --json`. That interface reuses the
CLI's saved authentication, streams JSON Lines events, reports usage, and can
resume a session by ID.

## Goal

Allow a user to select OpenAI, authenticate through Codex CLI in the WorkPilot
settings dialog, and run the WorkPilot pipeline against their ChatGPT/Codex
subscription without entering an OpenAI API key.

The existing API-key mode remains supported and unchanged.

## Non-goals

- WorkPilot will not read, copy, persist, refresh, or transmit OAuth tokens.
- WorkPilot will not send Codex OAuth tokens to OpenAI API endpoints.
- This change will not introduce a persistent Codex App Server or a Node.js
  sidecar.
- This change will not redesign provider profiles or add multi-account Codex
  switching.
- This change will not bypass Codex sandboxing or approval controls.

## Selected approach

Add a Python `CodexCliAgentClient` that implements WorkPilot's existing
`AgentClient` contract by launching `codex exec --json` as a child process.

This approach uses the public CLI boundary, keeps authentication owned by
Codex, works with the already-installed CLI, and avoids a cross-language SDK
bridge. The direct REST `OpenAIAgentClient` remains the implementation for API
key authentication.

## Settings and provider selection

Add an explicit OpenAI authentication mode to settings:

- `api-key`: use `OpenAIAgentClient` and inject `OPENAI_API_KEY` as today.
- `codex-cli`: use `CodexCliAgentClient` and do not require or inject an OpenAI
  API key.

Selecting or successfully authenticating in the `OAuth / Codex` tab stores
`codex-cli`. Saving the API key tab stores `api-key`. Existing installations
without the field use `api-key` when a real API key is configured; otherwise a
currently authenticated Codex CLI may be offered but is not inferred from a
stale settings label.

The frontend credential manager exports a non-secret execution signal such as
`OPENAI_AUTH_MODE=codex-cli` to backend subprocesses. The existing
`SELECTED_LLM_PROVIDER=openai` signal continues to select the provider.

`globalOpenAICodexOAuthToken` currently stores only a display label. It may be
retained temporarily for settings migration, but it must not be treated as
proof of live authentication. Live status comes exclusively from the Codex CLI
credential check.

## Authentication experience

The OpenAI OAuth tab will use the existing authentication-terminal flow:

1. Check whether Codex CLI is installed.
2. If needed, offer the existing supported installation action.
3. Launch `codex login` in the embedded terminal.
4. Let Codex open the browser and own the complete sign-in exchange.
5. Poll only for credential presence/status; never parse or expose token values.
6. On success, show the authenticated identity when available, select
   `codex-cli`, save settings, and mark OpenAI configured.
7. Provide clear, localized errors for missing CLI, cancelled login, timeout,
   expired credentials, and process launch failures.

The dialog must also offer reconnection and disconnection/status refresh. A
saved display label alone must never produce a connected state.

## Backend client

`CodexCliAgentClient` will accept the same relevant construction inputs as the
other clients: model, system prompt, project directory, agent type, and
reasoning effort.

For a new query it will launch a child process equivalent to:

```text
codex exec --json --sandbox workspace-write --cd <worktree> \
  --model <model> -c model_reasoning_effort=<effort> <prompt>
```

Arguments will be passed as an argument vector, not through a shell. The system
prompt and user prompt will be composed as input without putting credentials or
untrusted content into command-line configuration. WorkPilot will use the
platform executable abstraction rather than hard-coded executable names or OS
checks.

Codex itself owns file and command tools for this path. WorkPilot must not also
run its internal `ToolExecutor` loop for the same response, which would execute
actions twice and break the Codex permission model.

### Event translation

The client reads stdout line by line and parses documented JSONL events:

- `thread.started`: retain the thread ID for continuation.
- `item.completed` with `agent_message`: emit assistant text.
- progress item events: translate useful, safe summaries into WorkPilot status
  messages without leaking reasoning or credentials.
- `turn.completed`: store token usage in `last_usage`.
- `turn.failed` and `error`: emit a precise system error and fail the run.

Malformed individual progress lines may be logged and skipped. A malformed
terminal event, non-zero exit, missing final assistant message, or auth failure
must fail the operation with stderr sanitized for display.

### Session continuation

When WorkPilot continues the same agent session, the client will use:

```text
codex exec resume <thread-id> --json <prompt>
```

WorkPilot's existing serialized transcript remains the fallback context when no
Codex thread ID is available. A fresh-context phase starts a new Codex thread.
Session IDs are operational metadata, not credentials, and may be stored with
the existing task session metadata.

### Lifecycle and cancellation

The client retains the running child-process handle. Cancellation or client
exit terminates the child and waits for it to finish, preventing orphaned Codex
processes. stdout and stderr are drained concurrently to prevent pipe
deadlocks. Secrets and raw auth file contents are never logged.

## Security model

- Use `--sandbox workspace-write`; never use the dangerous bypass flags.
- Run with the task worktree as the only primary writable directory.
- Do not load or deserialize OAuth token values in the backend.
- Do not copy `auth.json` into project or task directories.
- Do not place prompts in a shell command string.
- Sanitize process errors before showing them in the UI or workflow logs.
- Preserve Codex's own project rules and approval behavior.

## Error handling

Errors must distinguish:

- Codex CLI not installed or too old for the required flags.
- No active Codex authentication.
- Authentication expired or revoked.
- Model unavailable for the signed-in ChatGPT plan.
- Child process could not start or exited unexpectedly.
- Invalid JSONL terminal event.
- Task cancellation.

User-facing messages must use `react-i18next` keys in both French and English.
Backend diagnostics may remain English but must contain the failing boundary and
safe remediation.

## Compatibility and migration

API-key users continue through `OpenAIAgentClient`. Existing settings with only
`globalOpenAICodexOAuthToken` are migrated conservatively: WorkPilot checks live
CLI authentication before selecting `codex-cli`; otherwise it shows the account
as disconnected.

Codex model selection must use models supported by the installed CLI and the
user's account. The implementation must not silently fall back to a different
provider. Unsupported models produce a visible error and preserve the task for
retry.

Windows, macOS, and Linux executable discovery and process invocation must use
the repository's platform abstraction.

## Testing strategy

Implementation follows test-driven development.

Backend tests will cover:

- choosing `CodexCliAgentClient` only for `openai + codex-cli`;
- retaining `OpenAIAgentClient` for `openai + api-key`;
- safe cross-platform argument construction for new and resumed sessions;
- JSONL parsing for messages, usage, thread IDs, errors, and malformed events;
- non-zero exits, missing authentication, cancellation, and child cleanup;
- no internal `ToolExecutor` initialization for the Codex path.

Frontend tests will cover:

- the restored login action and authenticated/disconnected states;
- saving the explicit authentication mode from each tab;
- refusing stale `globalOpenAICodexOAuthToken` labels as authentication proof;
- credential environment propagation without token material;
- French and English translation-key presence.

Focused tests run first for each red-green cycle. Final verification includes
the affected frontend test suites, backend provider/client tests, type checking,
Biome `2.4.10`, Ruff `0.15.7`, and repository diff checks.

## Acceptance criteria

1. A user can start `codex login` from the OpenAI settings dialog and complete
   browser authentication.
2. WorkPilot detects the live CLI session and visibly selects Codex CLI mode.
3. A WorkPilot task using OpenAI runs through `codex exec` without
   `OPENAI_API_KEY`.
4. Progress, final output, errors, usage, cancellation, and session continuation
   integrate with the current pipeline.
5. API-key OpenAI behavior remains functional.
6. Stale settings cannot masquerade as a valid Codex login.
7. OAuth secrets never enter WorkPilot settings, logs, prompts, or environment
   variables.
8. Automated tests pass on the supported platforms.
