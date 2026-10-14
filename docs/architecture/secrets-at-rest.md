# Secrets at rest

> Design rationale for rule S1 of [`docs/rules/security.md`](../rules/security.md),
> which stays the normative file: where the two disagree, the rule wins.

## A secret on disk is encrypted, or the user is told

The desktop app keeps credentials in three files under `userData`:
`settings.json` (the global provider keys and tokens), `auto-claude/profiles.json`
(each API profile's `apiKey`) and the Claude profiles (`oauthToken`). All three
used to be written in clear, or encrypted only when Electron `safeStorage`
happened to work and silently in clear otherwise.

One module now decides what a secret looks like on disk —
`apps/frontend/src/main/secret-storage.ts`:

| Situation | What is written | What the user sees |
|---|---|---|
| OS keyring (Keychain, DPAPI, libsecret, KWallet) | `enc:<base64>` safeStorage ciphertext | nothing |
| No keyring: `safeStorage` unavailable, or Linux `basic_text` | the secret itself, in a `0600` file | the sidebar banner (`SecureStorageBanner`), logged once |
| Encryption throws although a keyring is reported | the secret itself, in a `0600` file | the same banner |

`basic_text` counts as no keyring: it encrypts with a key compiled into
Chromium, which protects nothing. Writing in clear there is what lets the next
launch with a keyring encrypt for real — the startup migration only rewrites
values still in clear.

## One reader, one writer per file

Encryption happens at the file boundary, so every caller keeps seeing
plaintext:

| File | Reader / writer | Secret fields |
|---|---|---|
| `settings.json` | `settings-utils.ts` — `readSettingsFile`, `readSettingsFileAsync`, `writeSettingsFile` | `isSecretSettingsKey`: `global…ApiKey`, `…AccessKey`, `…Token`, `…Secret`, `…Password`, `customProviderApiKey` |
| `profiles.json` | `services/profile/profile-manager.ts` (`encodeProfilesForDisk` / `decodeProfilesFromDisk`), reused by `utils/profile-manager.ts` | `apiKey` |
| Claude profiles | `claude-profile/token-encryption.ts` | `oauthToken` |

That is why no module parses `settings.json` itself any more: the dozen
services that did so to inject `ANTHROPIC_API_KEY` or `CLAUDE_OAUTH_TOKEN`
into a Python subprocess would now hand it the ciphertext.

The key pattern is a pattern, not a list, because the provider grid names keys
the `AppSettings` type does not (`globalAzureApiKey`, `globalAwsAccessKey`…).

## Reading never destroys

A value that cannot be decrypted right now — `safeStorage` not ready yet (Linux
before `ready`), a locked keyring, a keychain prompt the user denied — is
handed back unchanged by the field helpers. Writing the record back keeps it.
The alternative, an empty string, loses the key on the next unrelated save;
for a profile it is worse, since an empty `apiKey` reads as a placeholder and
the credential manager deletes placeholder profiles on startup.

## Migration

`migrateSettingsSecrets` and `migrateProfilesSecrets` run once, after
`app.whenReady()` and before anything else reads the files. They restrict both
files to `0600` and rewrite them only when a secret is still in clear. Without
a keyring the rewrite keeps the values in clear and raises the banner.

## Status and warning

`getSecureStorageStatus()` returns `keyringAvailable`, the Linux `backend`, and
`secretsAtRisk`: a secret was written in clear this session, or secrets exist
while no keyring does. The renderer pulls it on start (`secureStorage:status`)
and the main process pushes it (`secureStorage:statusChanged`) the first time a
secret is seen and the first time one is written in clear. Dismissing the
banner lasts for the session; secrets newly exposed bring it back.

## Logs

`app-logger.ts` registers an electron-log hook that runs
`shared/utils/secret-redaction.ts` over every message before any transport
writes it — the main process's calls and the renderers', which electron-log
forwards to main. `appLog`'s console copy is redacted the same way, and
`getRecentLogs` redacts lines written before redaction existed, since they end
up in debug reports.

Redaction works by shape (`sk-ant-…`, `ghp_…`, `AIza…`, JWTs, `Bearer …`,
`user:password@` in URLs) and by name (`api_key=…`, `"token": "…"`, object keys
such as `apiKey` or `authorization`). It keeps the recognisable prefix, so a
reader still knows what leaked, and leaves `max_tokens=4096` or
`hasToken: true` alone.

## A project's `.workpilot/.env`

Each project's `.workpilot/.env` holds the tokens of its integrations
(`CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `LINEAR_API_KEY`,
`JIRA_API_TOKEN`, `AZURE_DEVOPS_PAT`, `CICD_JENKINS_TOKEN`, `CONTEXT7_API_KEY`,
`FIGMA_ACCESS_TOKEN`, provider keys, notification webhook URLs) next to
settings that are not secret. The Python backend cannot call `safeStorage`,
but it does not need to: it never loads the file in bulk. The main process
reads it and passes its variables to every Python subprocess it spawns
(`AgentProcessManager.getCombinedEnv`, `loadProjectEnvForSubprocess`), and the
backend readers that look at the file for a few keys of their own let a real
environment variable win.

So the file is encrypted at its boundary, like `settings.json`:

| | |
|---|---|
| Reader / writer | `apps/frontend/src/main/project-env-file.ts` — `readProjectEnv`, `readProjectEnvFor`, `readProjectEnvContent`, `writeProjectEnv`, `writeProjectEnvFile` |
| Secret keys | `isSecretProjectEnvKey`: `…_TOKEN`, `…_API_KEY`, `…_ACCESS_KEY`, `…_SECRET`, `…_PASSWORD`, `…_PAT`, `…_WEBHOOK_URL`, `DOCINTEL_AZURE_KEY` |
| On disk | `KEY=enc:<base64>`, every other line byte for byte; `0600` |
| Without a keyring | the value in clear, `0600`, the sidebar banner |
| Migration | `migrateProjectEnvSecrets`, run with the others for every known project |
| Git | each write and the migration check `git check-ignore`; when the file is not ignored, `.workpilot/` is added to the project's `.gitignore` |

A secret that cannot be decrypted right now is left out by `readProjectEnv`:
handed to a subprocess, ciphertext would win over the variable the backend
would otherwise read, and sent to an API it is not a token. The content
readers keep it as stored, so a save does not lose it.

### The CLI without the desktop app

`python run.py` and `runners/spec_runner.py` load `.env-files/.env` and the
process environment, never the project file in bulk; integration tokens have
always come from there. The few readers that do read the project file —
`core/client.py` (`CONTEXT7_API_KEY`), `docintel/settings.py`
(`DOCINTEL_AZURE_KEY`, `FIGMA_ACCESS_TOKEN`), `libdocs/preflight.py`,
`services/notifications/service.py` (webhook URLs) — go through
`core/project_env.py`: an `enc:` value counts as absent, a warning names the
key once and says to export it, and an exported variable is used. Ciphertext
is never handed to an MCP server or a webhook as if it were the secret.

`core/auth.py` gives `enc:` another meaning (a token the Claude Code CLI
encrypted). The two do not meet: `auth.py` reads environment variables, and
the main process never passes a value it could not decrypt.

### What the renderer sees

The renderer is not trusted (rule S6 of
[`docs/rules/security.md`](../rules/security.md)), so `ENV_GET` never hands it
a project token. Each secret field that is set (`PROJECT_ENV_SECRET_FIELDS` in
`env-handlers.ts`, plus `mcpServers.context7ApiKey`) reads as `MASKED_SECRET`
(`shared/constants/secrets.ts`), which is enough to tell "configured" from
"not configured". The global Claude token or OpenAI key a project falls back
to is masked the same way.

The settings screens save the whole config on every edit, so the mask comes
back. `ENV_UPDATE` treats it as "keep the stored value"
(`unmaskProjectEnvUpdate`). Text typed after the mask is the new value, since
the mask's character never occurs in a token or a URL. That also stops a
whole-config save from copying the global Claude token into the project file.

Two screens used to send the value itself somewhere, and now let the main
process read it:

- The Jira connection test passes `projectId`. A masked or empty token means
  the project's stored token, and without a project the test is refused.
- The notification webhook test goes through
  `env:testNotificationWebhook(projectId, channel, url?)`. The main process
  takes the stored URL for that channel (closed list) unless a new one was
  typed, and has the backend post it. Before, the renderer did that fetch
  itself.
