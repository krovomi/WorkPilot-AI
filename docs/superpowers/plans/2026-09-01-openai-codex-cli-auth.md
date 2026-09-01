# OpenAI Codex CLI Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run WorkPilot's OpenAI provider through an authenticated Codex CLI session when the user selects OAuth/Codex, while preserving direct API-key execution.

**Architecture:** Add an explicit `OPENAI_AUTH_MODE` signal at the Electron/backend boundary and route `openai + codex-cli` to a focused Python `CodexCliAgentClient`. The client invokes `codex exec --json` without a shell, translates JSONL events into WorkPilot messages, and lets Codex own tools, sandboxing, authentication, and session continuation.

**Tech Stack:** Electron 41, React 19, TypeScript 5.9, Vitest 4, Python 3.13, pytest, asyncio subprocesses, Codex CLI 0.149+.

**Spec:** `docs/superpowers/specs/2026-09-01-openai-codex-cli-auth-design.md`

## Global Constraints

- Preserve direct OpenAI API-key behavior.
- Never read, copy, persist, refresh, transmit, or log OAuth token values.
- Use `codex exec --json --sandbox workspace-write`; never use a dangerous bypass flag.
- Pass subprocess arguments as an argument vector, never through a shell.
- Use repository platform abstractions for executable discovery and process behavior.
- All user-visible frontend text must use `react-i18next` keys in both French and English.
- Use Biome `2.4.10` and Ruff `0.15.7` exactly.
- Tests must be written and observed failing before production changes.

---

### Task 1: Explicit OpenAI authentication mode propagation

**Files:**
- Modify: `apps/frontend/src/shared/types/settings.ts`
- Modify: `apps/frontend/src/shared/constants/config.ts`
- Modify: `apps/frontend/src/main/services/credential-manager.ts`
- Test: `apps/frontend/src/main/services/credential-manager.test.ts`

**Interfaces:**
- Consumes: persisted frontend settings and existing `SELECTED_LLM_PROVIDER` injection.
- Produces: `globalOpenAIAuthMode?: "api-key" | "codex-cli"` and backend environment variable `OPENAI_AUTH_MODE`.

- [ ] **Step 1: Write failing environment tests**

Add cases that persist OpenAI settings and assert observable environment output:

```ts
it("routes OpenAI through Codex CLI without exporting OAuth material", () => {
  writeSettings({
    selectedProvider: "openai",
    globalOpenAIAuthMode: "codex-cli",
    globalOpenAICodexOAuthToken: "display@example.com",
  });
  const env = manager.getEnvironmentVariables();
  expect(env.SELECTED_LLM_PROVIDER).toBe("openai");
  expect(env.OPENAI_AUTH_MODE).toBe("codex-cli");
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(Object.values(env)).not.toContain("display@example.com");
});

it("keeps API-key mode as the compatibility default", () => {
  writeSettings({ selectedProvider: "openai", globalOpenAIApiKey: "sk-test" });
  const env = manager.getEnvironmentVariables();
  expect(env.OPENAI_AUTH_MODE).toBe("api-key");
  expect(env.OPENAI_API_KEY).toBe("sk-test");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --dir apps/frontend test -- credential-manager.test.ts`

Expected: the Codex case lacks `OPENAI_AUTH_MODE` and the API case does not set the explicit default.

- [ ] **Step 3: Implement minimal propagation**

Add the settings type/default and inject only the non-secret mode:

```ts
export type OpenAIAuthMode = "api-key" | "codex-cli";

const openAIAuthMode = settings.globalOpenAIAuthMode === "codex-cli"
  ? "codex-cli"
  : "api-key";
env.OPENAI_AUTH_MODE = openAIAuthMode;
if (openAIAuthMode === "api-key" && apiKey) env.OPENAI_API_KEY = apiKey;
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm --dir apps/frontend test -- credential-manager.test.ts`

Expected: both new tests pass and existing credential-manager tests remain green.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/shared/types/settings.ts apps/frontend/src/shared/constants/config.ts apps/frontend/src/main/services/credential-manager.ts apps/frontend/src/main/services/credential-manager.test.ts
git commit -m "feat: propagate OpenAI authentication mode"
```

---

### Task 2: Codex CLI process and JSONL adapter

**Files:**
- Create: `apps/backend/core/codex_cli_client.py`
- Create: `tests/test_codex_cli_client.py`

**Interfaces:**
- Consumes: `AgentClient`, `AgentMessage`, `ContentBlock`, `MessageRole`, model, system prompt, project directory, and reasoning effort.
- Produces: `CodexCliAgentClient(AgentClient)`, `build_codex_exec_args(...)`, and event-to-message streaming through `receive_response()`.

- [ ] **Step 1: Write failing argument-construction tests**

```python
def test_new_turn_uses_safe_workspace_write_arguments(tmp_path):
    args = build_codex_exec_args(
        executable="codex",
        project_dir=tmp_path,
        model="gpt-5.6-sol",
        reasoning_effort="high",
        prompt="fix $(unsafe)",
        thread_id=None,
    )
    assert args == [
        "codex", "exec", "--json", "--sandbox", "workspace-write",
        "--cd", str(tmp_path), "--model", "gpt-5.6-sol",
        "-c", 'model_reasoning_effort="high"', "fix $(unsafe)",
    ]

def test_resume_targets_exact_thread_id(tmp_path):
    args = build_codex_exec_args(
        executable="codex", project_dir=tmp_path, model=None,
        reasoning_effort=None, prompt="continue", thread_id="thread-123",
    )
    assert args[:5] == ["codex", "exec", "resume", "thread-123", "--json"]
```

- [ ] **Step 2: Run argument tests and verify RED**

Run: `pytest tests/test_codex_cli_client.py -q`

Expected: import failure because `core.codex_cli_client` does not exist.

- [ ] **Step 3: Implement argument construction and executable lookup**

Use `shutil.which("codex")` as feature detection, add platform-specific `.cmd` fallback through the existing platform helpers, and return a list of strings. Do not use `shell=True`.

- [ ] **Step 4: Add failing JSONL behavior tests**

Drive the real parser with hand-authored documented event lines:

```python
EVENTS = [
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":3,"reasoning_output_tokens":1}}',
]

@pytest.mark.asyncio
async def test_stream_translates_final_message_usage_and_thread(fake_process, tmp_path):
    fake_process.stdout.feed_lines(EVENTS)
    client = CodexCliAgentClient(project_dir=str(tmp_path), process_factory=fake_process.factory)
    await client.query("work")
    messages = [message async for message in client.receive_response()]
    assert messages[-1].text == "done"
    assert client.thread_id == "thread-123"
    assert client.last_usage == {"input_tokens": 10, "cached_input_tokens": 2, "output_tokens": 3, "reasoning_output_tokens": 1}
```

Add separate cases for `turn.failed`, an `error` event, malformed progress JSON, malformed terminal JSON, non-zero exit, no final agent message, and cancellation cleanup.

- [ ] **Step 5: Run parser tests and verify RED**

Run: `pytest tests/test_codex_cli_client.py -q`

Expected: failures because the client does not yet translate or validate events.

- [ ] **Step 6: Implement minimal asynchronous client**

Implement:

```python
class CodexCliAgentClient(AgentClient):
    async def query(self, prompt: str) -> None: ...
    async def receive_response(self) -> AsyncIterator[AgentMessage]: ...
    async def __aenter__(self) -> "CodexCliAgentClient": ...
    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None: ...
```

Compose system and user text into the prompt, start with `asyncio.create_subprocess_exec`, drain stderr concurrently, parse stdout JSONL, retain `thread_id`, populate `last_usage`, sanitize errors, terminate/wait on cancellation, and never initialize `ToolExecutor`.

- [ ] **Step 7: Run client tests and verify GREEN**

Run: `pytest tests/test_codex_cli_client.py -q`

Expected: all adapter tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/core/codex_cli_client.py tests/test_codex_cli_client.py
git commit -m "feat: add Codex CLI agent client"
```

---

### Task 3: Route the OpenAI provider by authentication mode

**Files:**
- Modify: `apps/backend/core/client.py`
- Modify: `apps/backend/core/oneshot.py`
- Modify: `tests/test_agent_client_factory.py`
- Modify: `tests/test_codex_cli_client.py`

**Interfaces:**
- Consumes: `OPENAI_AUTH_MODE`, existing OpenAI model/effort resolution, and `CodexCliAgentClient`.
- Produces: `create_agent_client(... provider="openai")` returning the correct client without silent provider fallback.

- [ ] **Step 1: Write failing factory tests**

```python
def test_openai_codex_mode_returns_codex_cli_client(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_AUTH_MODE", "codex-cli")
    client = create_agent_client(provider="openai", project_dir=tmp_path, model="gpt-5.6-sol")
    assert isinstance(client, CodexCliAgentClient)

def test_openai_api_mode_returns_rest_client(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_AUTH_MODE", "api-key")
    client = create_agent_client(provider="openai", project_dir=tmp_path, model="gpt-5.6-sol")
    assert isinstance(client, OpenAIAgentClient)
```

Add a case proving the one-shot factory uses the same mode.

- [ ] **Step 2: Run factory tests and verify RED**

Run: `pytest tests/test_agent_client_factory.py tests/test_codex_cli_client.py -q`

Expected: Codex mode still returns `OpenAIAgentClient`.

- [ ] **Step 3: Implement mode routing**

Resolve the mode once with a strict helper:

```python
def _get_openai_auth_mode() -> str:
    mode = os.environ.get("OPENAI_AUTH_MODE", "api-key").strip().lower()
    return "codex-cli" if mode == "codex-cli" else "api-key"
```

Use the existing prompt and effort resolution for both paths. Construct `CodexCliAgentClient` only in `codex-cli` mode and retain the current REST client otherwise. Mirror this behavior in `oneshot.py`.

- [ ] **Step 4: Run factory/client tests and verify GREEN**

Run: `pytest tests/test_agent_client_factory.py tests/test_codex_cli_client.py -q`

Expected: both routing branches pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/core/client.py apps/backend/core/oneshot.py tests/test_agent_client_factory.py tests/test_codex_cli_client.py
git commit -m "feat: route OpenAI OAuth through Codex CLI"
```

---

### Task 4: Restore and harden the OAuth/Codex settings flow

**Files:**
- Modify: `apps/frontend/src/renderer/components/settings/OAuthAuthContent.tsx`
- Modify: `apps/frontend/src/renderer/components/settings/ProviderConfigDialog.tsx`
- Modify: `apps/frontend/src/renderer/components/settings/useProviderAuth.ts`
- Modify: `apps/frontend/src/main/services/credential-manager.ts`
- Modify: `apps/frontend/src/shared/i18n/locales/en/settings.json`
- Modify: `apps/frontend/src/shared/i18n/locales/fr/settings.json`
- Create: `apps/frontend/src/renderer/components/settings/OpenAICodexAuthContent.test.tsx`
- Modify: `apps/frontend/src/main/services/credential-manager.test.ts`

**Interfaces:**
- Consumes: existing `AuthTerminal`, `checkOpenAICodexOAuth`, `globalOpenAIAuthMode`, and Codex CLI install/status APIs.
- Produces: live login/status UI and conservative credential detection that never trusts a saved label.

- [ ] **Step 1: Write failing renderer tests**

Render the real OpenAI OAuth content and assert behavior through accessible roles:

```tsx
it("offers Codex CLI login instead of API-key-only guidance", async () => {
  render(<OpenAICodexAuthContent isAuthenticated={false} onLogin={onLogin} t={t} />);
  await user.click(screen.getByRole("button", { name: /sign in with chatgpt/i }));
  expect(onLogin).toHaveBeenCalledOnce();
});

it("shows the live account and allows reconnecting", () => {
  render(<OpenAICodexAuthContent isAuthenticated profileName="user@example.com" onLogin={onLogin} t={t} />);
  expect(screen.getByText("user@example.com")).toBeVisible();
  expect(screen.getByRole("button", { name: /reconnect/i })).toBeEnabled();
});
```

- [ ] **Step 2: Add failing stale-state credential test**

Persist only `globalOpenAICodexOAuthToken`, ensure no auth file exists, and assert `checkOpenAICodexOAuthStatusPublic()` returns `{ isAuthenticated: false }`.

- [ ] **Step 3: Run frontend tests and verify RED**

Run: `pnpm --dir apps/frontend test -- OpenAICodexAuthContent.test.tsx credential-manager.test.ts`

Expected: the OAuth content exposes no login action and stale settings report authenticated.

- [ ] **Step 4: Implement the live authentication UI**

Export a testable `OpenAICodexAuthContent`, wire `onOAuthAuth`, render the existing `AuthTerminal` while active, and save `globalOpenAIAuthMode = "codex-cli"` only after live IPC confirmation. Saving the API key tab sets `globalOpenAIAuthMode = "api-key"`.

Replace the obsolete warning translations with keys for description, login, authenticating, connected account, reconnect, missing CLI, timeout, cancelled login, and expired session in both locales.

- [ ] **Step 5: Remove stale-label authentication fallback**

Delete Source 4 from `checkOpenAICodexOAuthStatus()` so only real Codex credential files or real OpenAI API keys establish authentication. Never read token values beyond the minimal presence check already performed in the main process.

- [ ] **Step 6: Run frontend tests and verify GREEN**

Run: `pnpm --dir apps/frontend test -- OpenAICodexAuthContent.test.tsx credential-manager.test.ts`

Expected: login/status, mode persistence, and stale-state tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/renderer/components/settings/OAuthAuthContent.tsx apps/frontend/src/renderer/components/settings/ProviderConfigDialog.tsx apps/frontend/src/renderer/components/settings/useProviderAuth.ts apps/frontend/src/main/services/credential-manager.ts apps/frontend/src/shared/i18n/locales/en/settings.json apps/frontend/src/shared/i18n/locales/fr/settings.json apps/frontend/src/renderer/components/settings/OpenAICodexAuthContent.test.tsx apps/frontend/src/main/services/credential-manager.test.ts
git commit -m "feat: enable Codex CLI sign-in for OpenAI"
```

---

### Task 5: End-to-end compatibility and verification

**Files:**
- Modify if a real integration gap is exposed: `tests/test_codex_cli_client.py`
- Modify if a real integration gap is exposed: `apps/frontend/src/main/services/credential-manager.test.ts`

**Interfaces:**
- Consumes: completed frontend mode propagation, backend factory routing, and CLI adapter.
- Produces: verified OpenAI API and Codex CLI paths with no regressions.

- [ ] **Step 1: Run the focused backend suite**

Run: `pytest tests/test_codex_cli_client.py tests/test_agent_client_factory.py tests/test_agent_client.py tests/test_agent_session_provider.py -q`

Expected: PASS.

- [ ] **Step 2: Run the focused frontend suite**

Run: `pnpm --dir apps/frontend test -- OpenAICodexAuthContent.test.tsx credential-manager.test.ts provider-service-registry.test.ts`

Expected: PASS.

- [ ] **Step 3: Run static verification with pinned tools**

Run:

```bash
pnpm --dir apps/frontend run typecheck
pnpm exec biome@2.4.10 check apps/frontend/src/renderer/components/settings/OAuthAuthContent.tsx apps/frontend/src/renderer/components/settings/ProviderConfigDialog.tsx apps/frontend/src/renderer/components/settings/useProviderAuth.ts apps/frontend/src/main/services/credential-manager.ts apps/frontend/src/shared/types/settings.ts apps/frontend/src/shared/constants/config.ts
uvx ruff==0.15.7 check apps/backend/core/codex_cli_client.py apps/backend/core/client.py apps/backend/core/oneshot.py tests/test_codex_cli_client.py tests/test_agent_client_factory.py
uvx ruff==0.15.7 format --check apps/backend/core/codex_cli_client.py apps/backend/core/client.py apps/backend/core/oneshot.py tests/test_codex_cli_client.py tests/test_agent_client_factory.py
```

Expected: all commands exit zero.

- [ ] **Step 4: Perform a credential-safe smoke test**

Run `codex --version` and, only when the current machine is already authenticated, run a read-only temporary-repository `codex exec --json --sandbox read-only` prompt. Assert a `thread.started`, an `agent_message`, and `turn.completed` event without printing or inspecting `auth.json`.

- [ ] **Step 5: Review the final diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors and only scoped implementation/test/documentation changes.

- [ ] **Step 6: Commit any verification-only corrections**

```bash
git add apps/backend apps/frontend tests
git commit -m "test: verify Codex CLI OpenAI authentication"
```
