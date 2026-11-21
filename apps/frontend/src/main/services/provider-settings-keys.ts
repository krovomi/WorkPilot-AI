/**
 * Where each API-key provider keeps its key in Settings, and the environment
 * variables the backend reads it from. CredentialManager used to hold two
 * copies of the first map (connection test, backend environment) that had
 * drifted apart; both read this one.
 */
import { GATEWAY_PROVIDERS, gatewayMap, gatewayProvider } from "../../shared/constants/gateway-providers";

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
