/**
 * Where each API-key provider keeps its key in Settings, and the environment
 * variables the backend reads it from. CredentialManager used to hold two
 * copies of the first map (connection test, backend environment) that had
 * drifted apart; both read this one.
 */
import { GATEWAY_PROVIDERS, gatewayMap, gatewayProvider } from "../../shared/constants/gateway-providers";
import {
	type GatewayRoutingSettings,
	gatewayRoutingEnv,
} from "../../shared/constants/gateway-routing";
import {
	type ProviderDefaultModelSettings,
	providerDefaultModel,
} from "../../shared/utils/provider-default-model";

/** Settings fields that may hold the provider's key, in the order they are read. */
export const PROVIDER_SETTINGS_KEYS: Readonly<Record<string, readonly string[]>> = {
	openai: ["globalOpenAIApiKey"],
	google: ["globalGoogleDeepMindApiKey", "globalGoogleApiKey"],
	gemini: ["globalGoogleApiKey", "globalGoogleDeepMindApiKey"],
	mistral: ["globalMistralApiKey"],
	deepseek: ["globalDeepSeekApiKey"],
	grok: ["globalGrokApiKey"],
	meta: ["globalMetaApiKey"],
	aws: ["globalAWSApiKey"],
	cursor: ["globalCursorApiKey"],
	windsurf: ["globalWindsurfApiKey"],
	...gatewayMap((gateway) => [gateway.settingsKey]),
};

/** The environment variable that carries the key to the backend. */
export const PROVIDER_KEY_ENV_VARS: Readonly<Record<string, string>> = {
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_API_KEY",
	gemini: "GOOGLE_API_KEY",
	mistral: "MISTRAL_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	grok: "GROK_API_KEY",
	meta: "META_API_KEY",
	aws: "AWS_ACCESS_KEY_ID",
	windsurf: "WINDSURF_API_KEY",
	...gatewayMap((gateway) => gateway.envVar),
};

/** The environment variable that carries an API profile's endpoint. */
export const PROVIDER_BASE_URL_ENV_VARS: Readonly<Record<string, string>> = {
	openai: "OPENAI_BASE_URL",
	mistral: "MISTRAL_BASE_URL",
	deepseek: "DEEPSEEK_BASE_URL",
	grok: "GROK_BASE_URL",
	meta: "META_BASE_URL",
	aws: "AWS_BEDROCK_ENDPOINT",
	...gatewayMap((gateway) => gateway.baseUrlEnvVar),
};

/**
 * The environment variables that carry the provider page's default model to
 * the backend (`phase_config` reads them): `OLLAMA_MODEL` and its alias
 * `LOCAL_LLM_MODEL` for a local server, `<GATEWAY>_MODEL` for a gateway. Empty
 * when the page names no model.
 */
export function providerModelEnv(
	provider: string,
	settings: ProviderDefaultModelSettings | undefined,
): Record<string, string> {
	const model = providerDefaultModel(provider, settings);
	if (!model) return {};
	const gateway = gatewayProvider(provider);
	if (gateway) return { [gateway.modelEnvVar]: model };
	return { OLLAMA_MODEL: model, LOCAL_LLM_MODEL: model };
}

/** What the provider page hands the backend: its model and, for a gateway, its routing. */
export function providerPageEnv(
	provider: string,
	settings: (ProviderDefaultModelSettings & GatewayRoutingSettings) | undefined,
): Record<string, string> {
	return { ...providerModelEnv(provider, settings), ...gatewayRoutingEnv(provider, settings) };
}

/** Providers that run on an API key of their own, not on Claude's sign-in. */
export const NON_CLAUDE_PROVIDERS: readonly string[] = [
	"copilot",
	"openai",
	"google",
	"ollama",
	"meta",
	"mistral",
	"deepseek",
	"grok",
	"aws",
	"custom",
	...GATEWAY_PROVIDERS.map((gateway) => gateway.id),
];

/**
 * A gateway key checked on the gateway's account endpoint, never on a URL
 * the renderer named: the model list answers any key. Undefined for another
 * provider.
 */
export function gatewayKeyCheck(
	provider: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<Response> | undefined {
	const gateway = gatewayProvider(provider);
	if (!gateway) return undefined;
	return fetch(gateway.keyCheckUrl, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	});
}
