/**
 * Model gateways: one key, many vendors' models, an OpenAI-compatible API.
 *
 * OpenRouter and Hugging Face Inference Providers (whose chat router is
 * served by OpenRouter since 2026-11-16). The backend drives both with its
 * OpenAI-compatible client (`apps/backend/gateway_providers.py`); this file is
 * the renderer and main side of the same facts, so the maps that list
 * providers (settings key, environment variable, key test, detection) all
 * read one place.
 */

export type GatewayProviderId = "openrouter" | "huggingface";

export interface GatewayProvider {
	readonly id: GatewayProviderId;
	readonly label: string;
	/** The Settings field that stores the key (masked to the renderer). */
	readonly settingsKey: "globalOpenRouterApiKey" | "globalHuggingFaceApiKey";
	/** The environment variable the backend reads the key from. */
	readonly envVar: string;
	/** The environment variable that overrides the endpoint. */
	readonly baseUrlEnvVar: string;
	/** The OpenAI-compatible endpoint, up to `/v1`. */
	readonly baseUrl: string;
	/**
	 * The account endpoint, which refuses a bad key; the model list answers
	 * without one, so a key test on it would accept anything.
	 */
	readonly keyCheckUrl: string;
	/** Hosts an API profile URL may name to be read as this gateway. */
	readonly domainPatterns: readonly string[];
	/** What a key looks like, for the input's placeholder. */
	readonly keyPlaceholder: string;
	/** Where the user creates a key. */
	readonly keyPageUrl: string;
}

export const GATEWAY_PROVIDERS: readonly GatewayProvider[] = [
	{
		id: "openrouter",
		label: "OpenRouter",
		settingsKey: "globalOpenRouterApiKey",
		envVar: "OPENROUTER_API_KEY",
		baseUrlEnvVar: "OPENROUTER_BASE_URL",
		baseUrl: "https://openrouter.ai/api/v1",
		keyCheckUrl: "https://openrouter.ai/api/v1/key",
		domainPatterns: ["openrouter.ai"],
		keyPlaceholder: "sk-or-...",
		keyPageUrl: "https://openrouter.ai/settings/keys",
	},
	{
		id: "huggingface",
		label: "Hugging Face",
		settingsKey: "globalHuggingFaceApiKey",
		envVar: "HUGGINGFACE_API_KEY",
		baseUrlEnvVar: "HUGGINGFACE_BASE_URL",
		baseUrl: "https://router.huggingface.co/v1",
		keyCheckUrl: "https://huggingface.co/api/whoami-v2",
		domainPatterns: ["router.huggingface.co", "huggingface.co", "hf.co"],
		keyPlaceholder: "hf_...",
		// A fine-grained token with "Make calls to Inference Providers".
		keyPageUrl:
			"https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained",
	},
];

export const GATEWAY_PROVIDER_IDS: readonly GatewayProviderId[] =
	GATEWAY_PROVIDERS.map((gateway) => gateway.id);

export function isGatewayProvider(id: string | undefined | null): id is GatewayProviderId {
	return GATEWAY_PROVIDERS.some((gateway) => gateway.id === id);
}

export function gatewayProvider(id: string | undefined | null): GatewayProvider | undefined {
	return GATEWAY_PROVIDERS.find((gateway) => gateway.id === id);
}

/** `{ openrouter: value(openrouter), huggingface: value(huggingface) }`. */
export function gatewayMap<T>(value: (gateway: GatewayProvider) => T): Record<GatewayProviderId, T> {
	return Object.fromEntries(GATEWAY_PROVIDERS.map((gateway) => [gateway.id, value(gateway)])) as Record<
		GatewayProviderId,
		T
	>;
}
