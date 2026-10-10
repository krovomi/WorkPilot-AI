# Model catalogues

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## New models without a pull request

ChatGPT-authenticated Codex is separate from the OpenAI API registry.
`codex_models.py` queries `codex app-server` through `core/codex_catalog_rpc.py`
using the backend's PATH and CODEX_HOME, then caches discovery for 15 minutes.
Explicit refresh bypasses that cache; the Codex sidebar refresh/update actions
also refresh model selectors. Discovery never starts an agent turn or reads
OAuth credentials. On failure it returns the local `models_cache.json` with an
error, or the conservative static fallback; strict offline mode never starts
discovery. An old CLI can expose fewer models than the desktop Codex app:
update the CLI through the sidebar before expecting newly released models.
The Codex selector may append models returned by the OpenAI API catalogue when
an OpenAI API key is configured. This is a display convenience, not a claim
that the Codex account can call those models: Codex account IDs remain first
and authoritative, and an API-only selection is routed through the OpenAI API.
Without a key, the selector contains only the Codex account inventory and its
offline fallback.

The dropdowns used to learn about a release in one of two ways: the provider's
own `/v1/models`, which needs an API key, or a line added to
`models_registry.py`. Most users have no key — Claude runs on a Claude Code
subscription, Copilot on a GitHub login, Bedrock on AWS credentials the
catalogue never sees — so for them a model like Claude Opus 5.5 stayed invisible
until somebody opened a pull request.

`public_model_registry.py` is the third source: the open
[models.dev](https://models.dev) registry (MIT), one keyless JSON document,
downloaded once for every provider, slimmed to the providers and fields
WorkPilot reads, and cached for six hours. `provider_models_catalog.list_models`
asks it **after** a live answer and **before** a stale cache — only the provider
can say what an account may call, but a cache that failed to refresh is older
knowledge of what the registry already knows.

Three rules keep it from putting noise in a selector:

| Rule | Why |
|---|---|
| the same allow-list as the live fetchers (`_registry_allows`) | the registry lists embeddings, image and speech models; a looser second rule would show exactly what the live path keeps out |
| a model that cannot call a tool, does not read and write text, or is deprecated is dropped | it cannot drive a phase |
| the registry adds, never removes, and a curated tier wins over the keyword guess | it is community-maintained and lags on some providers |

It never fails a dropdown: unreachable, refused by a proxy, unparseable — the
static list answers, and the failure is remembered for ten minutes so a page
opening six selectors does not wait six timeouts. Local runtimes never ask it:
their list is what is installed on the machine. `MODEL_REGISTRY_ENABLED=false`
turns it off; see [CONFIGURATION.md](../CONFIGURATION.md).

`models_registry.py` stays the place for what the registry cannot know: the
default model of a provider, curated tiers, and prices. A release no longer
needs it to be *selectable*.
