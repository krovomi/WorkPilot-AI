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

## Not covered here

A project's `.workpilot/.env` still holds the tokens the Python backend reads
(`CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_KEY`…). The backend cannot call
`safeStorage`; protecting that file needs a different design.
