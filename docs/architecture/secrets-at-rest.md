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
| A process that cannot call `safeStorage` reads the file itself (a project's `readable` keys, the backend's `.env` from source) | the secret itself, in a `0600` file | the banner, naming the keys |

`basic_text` counts as no keyring: it encrypts with a key compiled into
Chromium, which protects nothing. Writing in clear there is what lets the next
launch with a keyring encrypt for real — the startup migration only rewrites
values still in clear.

## Linux without a declared desktop (WSL)

Chromium chooses its Linux password store from the desktop the session
declares: `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, `GNOME_DESKTOP_SESSION_ID`,
`KDE_FULL_SESSION`. With none of them set it picks `basic_text`, whatever runs
on the session bus. That is the default under WSL, a bare X server or an SSH
session: a user who starts GNOME Keyring in their shell profile still got the
banner asking them to install one.

`apps/frontend/src/main/linux-password-store.ts` handles that one case before
`ready`, when Chromium reads the switch. With no desktop declared, a session
bus address set and `org.freedesktop.secrets` owned on that bus (`dbus-send`
calling `NameHasOwner`), it adds `--password-store=gnome-libsecret`.

- An explicit `--password-store`, `basic` included, always wins.
- A declared desktop keeps Chromium's choice, even one it does not recognise
  (`i3`, `sway`): forcing libsecret where KWallet holds the key would make
  every `enc:` value unreadable. Such a session passes the flag itself.
- A Secret Service D-Bus could only activate does not count: starting it
  opens a "create a keyring" prompt the user never asked for.
- The probe gets the bus address and `XDG_RUNTIME_DIR`, not the app's
  environment, which holds the `.env-files` secrets by then (rule S4).

If libsecret then fails (keyring locked, prompt refused),
`safeStorage.isEncryptionAvailable()` is false: Chromium only reports a key
the store returned, while `getSelectedStorageBackend()` names the store asked
for. `secret-storage.ts` keeps writing in clear and the banner stays, as
before. The values encrypted in a session with the keyring need it in the
next: launched without it, they cannot be decrypted and are kept as they are
(see *Reading never destroys*).

## One reader, one writer per file

Encryption happens at the file boundary, so every caller keeps seeing
plaintext:

| File | Reader / writer | Secret fields |
|---|---|---|
| `settings.json` | `settings-utils.ts` — `readSettingsFile`, `readSettingsFileAsync`, `writeSettingsFile` | `isSecretSettingsKey`: `global…ApiKey`, `…AccessKey`, `…Token`, `…Secret`, `…Password`, `customProviderApiKey` |
| `profiles.json` | `services/profile/profile-manager.ts` (`encodeProfilesForDisk` / `decodeProfilesFromDisk`), reused by `utils/profile-manager.ts` | `apiKey` |
| Claude profiles | `claude-profile/token-encryption.ts` | `oauthToken` |
| `<project>/.workpilot/.env` | `project-env-file.ts` — `readProjectEnv`, `writeProjectEnvFile` | the `encrypted` list of `project-env-secrets.json` (below) |
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
its secrets in clear, and `writeSourceEnvFile` reports their keys through
`setReadableSecrets`, as `project-env-file.ts` does for a project's `readable`
keys: the banner names them for as long as the file holds them, keyring or not.
Its advice: configure Claude in Settings, whose credentials are encrypted, and
remove the token from the file. In the agent processes, the Claude profile's
token already wins over the file's (`setupProcessEnvironment` spreads it after
the `.env` values).

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

`migrateSettingsSecrets`, `migrateProfilesSecrets`, `migrateProjectEnvSecrets`
and `migrateSourceEnvSecrets` run once, after `app.whenReady()` and before
anything else reads the files. They restrict the files to `0600` and rewrite
them only when a secret is still in clear. Without a keyring the rewrite keeps
the values in clear and raises the banner. The backend's `.env` from source is
never rewritten: it is restricted, and its secret keys are named by the banner.

## Status and warning

`getSecureStorageStatus()` returns `keyringAvailable`, the Linux `backend`,
`readableSecretKeys` (the names of the secrets a file keeps in clear because
Python reads them there: a project's `readable` keys, the backend's `.env` from
source) and `secretsAtRisk`: a secret was written in clear this session,
secrets exist while no keyring does, or a key is kept readable. The renderer
pulls it on start (`secureStorage:status`) and the main process pushes it
(`secureStorage:statusChanged`) the first time a secret is seen, the first time
one is written in clear, and when the readable keys change. With a keyring the
banner names the readable keys; without one it gives the keyring advice.
Dismissing it lasts for the session; secrets newly exposed, or a key it has not
named yet, bring it back.

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

The settings screen writes each project's integration tokens to
`<project>/.workpilot/.env`, and the Python backend reads that file with its
own parsers. Python cannot call `safeStorage`, so the file holds two kinds of
secrets, listed in `apps/frontend/src/shared/constants/project-env-secrets.json`:

| Kind | Keys | On disk | How Python gets the value |
|---|---|---|---|
| `encrypted` | `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `AZURE_DEVOPS_PAT`, `JIRA_API_TOKEN`, `CICD_JENKINS_TOKEN`, `CICD_GITHUB_TOKEN`, `CICD_GITLAB_TOKEN`, `CICD_AZURE_TOKEN`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`, `VOYAGE_API_KEY`, `GOOGLE_API_KEY` | `enc:` ciphertext | only from its environment, which the main process builds from this file and decrypts on the way (`getCombinedEnv`, `loadProjectEnvForSubprocess`, `loadProjectEnvVars`) |
| `readable` | `CONTEXT7_API_KEY`, `CUSTOM_MCP_SERVERS` (when a server has HTTP headers), `FIGMA_ACCESS_TOKEN`, `DOCINTEL_AZURE_KEY`, the five notification webhook URLs | in clear, file `0600` | from the file itself |

The split follows the readers, not how sensitive a key is. A `readable` key is
read from the file by processes the app starts without the project's
environment: the long-lived API server (Figma import, notifications, docintel)
and the runners that build a client for any project (`create_client` loads
`CONTEXT7_API_KEY` and `CUSTOM_MCP_SERVERS` through
`load_project_mcp_config`). Ciphertext there would silently break those
features. Those keys therefore stay in clear and are reported to the status as
`readableSecretKeys`. The banner then names them even when a keyring exists,
because a secret in clear is never kept without the user being told.

`apps/frontend/src/main/project-env-file.ts` is the one reader and writer in
the main process. Every handler that reads the file (Linear, Jira, GitHub,
GitLab, Azure DevOps, CI pipelines, PR creation, the agent process) goes
through `readProjectEnv`, which decrypts. A value it cannot decrypt is left
out: a subprocess gets no token rather than ciphertext, and the file keeps the
value. `writeProjectEnvFile` encrypts the `encrypted` keys and keeps every
other line byte for byte. `migrateProjectEnvSecrets` runs at startup and when a
project is added: it rewrites the tokens an earlier version wrote in clear and
restricts the file to its owner.

Git must ignore the file. `initializeProject` ignores `.workpilot/`, but a
`.env` saved before initialization, or a `.workpilot/` renamed from a legacy
`.auto-claude/`, never went through it. `ensureProjectEnvIgnored` asks
`git check-ignore` and, when the file is not ignored, adds `.workpilot/.env`
itself, never the directory: a team that commits `.workpilot/specs/` through a
negation keeps doing so.

`tests/test_project_env_secrets.py` holds the backend to the split: no reader
of the file returns an `enc:` value, the `readable` keys still reach their
readers, and a new module that opens the file fails the test until it is
classified. On the frontend, `env-handlers-secrets.test.ts` fails when the
`.env` template gains a key that looks like a secret and is not classified.

### CI/CD trigger settings

The CI/CD triggers screen used to keep its settings and tokens
(`CICD_GITHUB_TOKEN`, `CICD_GITLAB_TOKEN`, `CICD_AZURE_TOKEN`,
`CICD_JENKINS_TOKEN`…) in the project's **root** `.env`. That file belongs to
the user's application, the tokens sat in it in clear, and WorkPilot's
`.gitignore` entries do not cover it. They now live in `.workpilot/.env` with
the rest, as `encrypted` keys:

- `cicd-triggers-handlers.ts` reads and writes them through
  `project-env-file`. It also checks what the renderer sends:
  - the directory must be one of the user's projects (`findKnownProject`);
  - only the fields of `CICD_CONFIG_KEYS` are written;
  - a value spanning lines is refused;
  - a token sent back as the `***` mask `getConfig` shows keeps its stored
    value.
- The runner receives only the decrypted `CICD_*` settings in its
  environment; the root `.env` is no longer spread into it.
  `cicd_triggers_runner.load_env` lets that environment win over the root
  file.
- At startup, `migrateRootEnvCicdKeys` moves the `CICD_*` lines out of each
  root `.env`. It writes `.workpilot/.env` first, where a value already set
  wins. The root file then loses only those lines and keeps its mode.

### What the renderer sees

The renderer is not trusted (rule S6 of
[`docs/rules/security.md`](../rules/security.md)), so `ENV_GET` never hands
it a project secret, whether it is encrypted or readable. Each secret field
that is set reads as `MASKED_SECRET` (`shared/constants/secrets.ts`), which
is enough to tell "configured" from "not configured". The fields are listed
in `PROJECT_ENV_SECRET_FIELDS` in `env-handlers.ts`, plus
`mcpServers.context7ApiKey`. When a project falls back to the global Claude
token or OpenAI key, that value is masked the same way.

The settings screens save the whole config on every edit, so the mask comes
back. `ENV_UPDATE` treats it as "keep the stored value"
(`unmaskProjectEnvUpdate`). Text typed after the mask is the new value; the
mask's character never occurs in a token or a URL. This also stops a
whole-config save from copying the global Claude token into the project
file.

Saving the whole config is also why the renderer's copy is **bound to the
project it was read for**. Loading is asynchronous, so for a few renders a
screen holds the previous project's configuration while the selected project
is already the new one — and the fields are uncontrolled inputs whose `onBlur`
fires exactly then, as the pointer leaves them for the project switcher. A save
in that window wrote one project's settings into another project's file. It was
found on disk: a local-only test project with no git remote at all held
`GITHUB_REPO=krovomi/WorkPilot-AI`, `GITHUB_AUTO_SYNC=true` and another
project's Context7 key — the key in clear, because the copy predates the mask
above. `useProjectEnvConfig` therefore *derives* `envConfig` rather than
storing it, null unless what was loaded belongs to the project selected right
now, so the existing `if (!envConfig) return` guards hold in every ordering; a
check in an effect would still leave the render in between. The settings
dialog's `committedEnvConfigRef` carries the same project id and refuses a save
whose base belongs elsewhere.

Two screens used to send the value itself somewhere. The main process now
reads it instead:

- **Jira connection test.** It passes `projectId`. A masked or empty token
  means the project's stored token. Without a project, the test is refused.
- **Notification webhook test.** It goes through
  `env:testNotificationWebhook(projectId, channel, url?)`. The main process
  takes the URL stored for that channel (closed list) unless a new one was
  typed, and has the backend post it. Before, the renderer did that fetch
  itself.
