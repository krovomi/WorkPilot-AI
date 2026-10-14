# Secrets at rest

> Design rationale for rule S1 of [`docs/rules/security.md`](../rules/security.md),
> which stays the normative file: where the two disagree, the rule wins.

## A secret on disk is encrypted, or the user is told

The desktop app keeps credentials in three files under `userData`:
`settings.json` (the global provider keys and tokens), `auto-claude/profiles.json`
(each API profile's `apiKey`) and the Claude profiles (`oauthToken`), plus the
backend's own `.env`, where the environment dialog saves the Claude token. All
of them used to be written in clear, or encrypted only when Electron
`safeStorage` happened to work and silently in clear otherwise.

One module now decides what a secret looks like on disk —
`apps/frontend/src/main/secret-storage.ts`:

| Situation | What is written | What the user sees |
|---|---|---|
| OS keyring (Keychain, DPAPI, libsecret, KWallet) | `enc:<base64>` safeStorage ciphertext | nothing |
| No keyring: `safeStorage` unavailable, or Linux `basic_text` | the secret itself, in a `0600` file | the sidebar banner (`SecureStorageBanner`), logged once |
| Encryption throws although a keyring is reported | the secret itself, in a `0600` file | the same banner |
| A process that cannot call `safeStorage` reads the file itself (the backend's `.env` from source) | the secret itself, in a `0600` file | the banner, naming the file |

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
| the backend's `.env` (the "source env") | `source-env.ts`: `writeSourceEnvFile`, and `loadBackendEnv` for subprocess environments; the `AUTOBUILD_SOURCE_ENV_*` handlers read the token back | `isSourceEnvSecretKey`: `CLAUDE_CODE_OAUTH_TOKEN`, `…_API_KEY`, `…_TOKEN`, `…_SECRET`, `…_PAT`… |

That is why no module parses `settings.json` itself any more: the dozen
services that did so to inject `ANTHROPIC_API_KEY` or `CLAUDE_OAUTH_TOKEN`
into a Python subprocess would now hand it the ciphertext.

The key pattern is a pattern, not a list, because the provider grid names keys
the `AppSettings` type does not (`globalAzureApiKey`, `globalAwsAccessKey`…).

## The backend's own `.env`

`AUTOBUILD_SOURCE_ENV_UPDATE` saves the Claude token to the backend's `.env`.
That file has two locations (`getSourceEnvPath` in `settings-handlers.ts`), and
who reads each one decides what a secret looks like in it:

| Running | File | Read by | Secrets |
|---|---|---|---|
| from source | `apps/backend/.env` | the main process (`loadAutoBuildEnv` in `agent/agent-process.ts`, `oneshot-llm.ts`, `changelog/changelog-service.ts`, `insights/config.ts`) **and Python itself**: `runners/github/runner.py` and `runners/gitlab/runner.py` load `Path(__file__).parent.parent.parent / ".env"`, and `provider_api.py`, run directly, calls a bare `load_dotenv()`, which walks up from `apps/backend/` | in clear, `0600`, named by the banner |
| packaged | `<userData>/backend/.env` | the main process only: the `AUTOBUILD_SOURCE_ENV_GET` / `_CHECK_TOKEN` handlers, and the same four readers through `loadBackendEnv`, which decrypts. No Python code knows this path | `enc:`, like `settings.json` |

Python cannot call `safeStorage`, so a file it loads cannot hold `enc:` values:
`python-dotenv` would load the ciphertext wherever the variable is not
already set, as when a runner is started by hand. That file keeps
its secrets in clear, and `writeSourceEnvFile` reports it through
`reportPlaintextSecretFile`, so the banner names it for as long as it holds a
secret, keyring or not. Its advice: configure Claude in Settings, whose
credentials are encrypted, and remove the token from the file. In the agent
processes, the Claude profile's token already wins over the file's
(`setupProcessEnvironment` spreads it after the `.env` values).

The four readers share one function, `loadBackendEnv` in `source-env.ts`. It
reads the `.env` of the backend source they run (`<resources>/backend`,
`<userData>/backend-source` or `autoBuildPath`), then, packaged, the copy the UI
saved under userData, which wins: otherwise the token saved from the dialog
would reach no subprocess, since the bundle leaves its own `.env` out. Secrets
come back decrypted. One the keyring cannot decrypt right now is left out,
never handed to Python as ciphertext, and so is an empty line, which the writer
always emits for the token: neither masks a value from another layer. Every
caller layers the Claude profile after it, so the profile's token still wins.

The handler revalidates its argument (rule S6): the token is a string on one
line, since the file holds one variable per line.

## Reading never destroys

A value that cannot be decrypted right now — `safeStorage` not ready yet (Linux
before `ready`), a locked keyring, a keychain prompt the user denied — is
handed back unchanged by the field helpers. Writing the record back keeps it.
The alternative, an empty string, loses the key on the next unrelated save;
for a profile it is worse, since an empty `apiKey` reads as a placeholder and
the credential manager deletes placeholder profiles on startup.

## Migration

`migrateSettingsSecrets`, `migrateProfilesSecrets` and `migrateSourceEnvSecrets`
run once, after `app.whenReady()` and before anything else reads the files.
They restrict the files to `0600` and rewrite them only when a secret is still
in clear. Without a keyring the rewrite keeps the values in clear and raises
the banner. The backend's `.env` from source is never rewritten: it is
restricted, and named by the banner if it holds a secret.

## Status and warning

`getSecureStorageStatus()` returns `keyringAvailable`, the Linux `backend`,
`encryptionUnavailable` (a secret was written in clear this session, or secrets
exist while no keyring does), `plaintextFiles` (files holding a secret in clear
because another process reads them) and `secretsAtRisk`, true for either. The
renderer pulls it on start (`secureStorage:status`) and the main process pushes
it (`secureStorage:statusChanged`) the first time a secret is seen, the first
time one is written in clear, and when a file joins or leaves `plaintextFiles`.
The banner gives the keyring advice for the first reason and lists the files
for the second. Dismissing it lasts for the session; secrets newly exposed
bring it back.

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

## Not covered here

A project's `.workpilot/.env` still holds the tokens the Python backend reads
(`CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`…). The backend cannot call
`safeStorage`; protecting that file needs a different design.
