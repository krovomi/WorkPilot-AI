/**
 * How a provider of Settings → AI accounts signs in, from what the renderer may
 * know: API profiles and Settings keys (both masked), the provider registry and
 * the page's connection status. No stored secret reaches the renderer.
 */
import { getProvider as getRegistryProvider } from "@shared/services/providerRegistry";
import type { AuthMethod } from "@shared/types/agent";
import type { APIProfile } from "@shared/types/profile";
import { detectProvider } from "@shared/utils/provider-detection";
import type { ProviderCardData } from "./CleanProviderCard";

type KeyInfo = NonNullable<ProviderCardData["realApiKeyInfo"]>;

/** The Settings key each provider reads when it has no API profile. */
const SETTINGS_KEY: Readonly<Record<string, string>> = {
	openai: "globalOpenAIApiKey",
	gemini: "globalGoogleApiKey",
	google: "globalGoogleDeepMindApiKey",
	meta: "globalMetaApiKey",
	"meta-llama": "globalMetaLlamaApiKey",
	mistral: "globalMistralApiKey",
	deepseek: "globalDeepSeekApiKey",
	grok: "globalGrokApiKey",
	windsurf: "globalWindsurfApiKey",
	cursor: "globalCursorApiKey",
	aws: "globalAWSApiKey",
	"azure-openai": "globalOpenAIApiKey",
};

/** How the registry says a provider signs in. */
export function providerAuthMethod(providerId: string): AuthMethod {
	const provider = getRegistryProvider(providerId);
	if (provider?.requiresCLI) return "cli";
	if (provider?.requiresOAuth && !provider.requiresApiKey) return "oauth";
	if (provider && !provider.requiresApiKey && !provider.requiresOAuth) return "local";
	return "api-key";
}

function isGoogleApisHost(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host === "googleapis.com" || host.endsWith(".googleapis.com");
	} catch {
		return false;
	}
}

function profileFor(providerId: string, profiles: readonly APIProfile[]): APIProfile | undefined {
	return profiles.find((profile) => {
		if (!profile.baseUrl) return false;
		const detected = detectProvider(profile.baseUrl);
		return (
			detected === providerId ||
			(providerId === "claude" && detected === "anthropic") ||
			((providerId === "gemini" || providerId === "google") && isGoogleApisHost(profile.baseUrl))
		);
	});
}

export function providerKeyInfo(
	providerId: string,
	profiles: readonly APIProfile[],
	settings: Readonly<Record<string, unknown>> & { credentialsSetAt?: Record<string, string | number> },
	connected: boolean,
): KeyInfo {
	const authMethod = providerAuthMethod(providerId);
	const profile = profileFor(providerId, profiles);
	if (profile?.apiKey) {
		return { hasKey: true, provider: profile.name, authMethod: "api-key", setAt: profile.apiKeySetAt };
	}
	const field = SETTINGS_KEY[providerId];
	if (field && settings[field]) {
		return { hasKey: true, authMethod: "api-key", setAt: settings.credentialsSetAt?.[field] };
	}
	if ((authMethod === "cli" || authMethod === "oauth") && profile) {
		return { hasKey: true, provider: profile.name, authMethod };
	}
	if (authMethod === "local") return { hasKey: true, authMethod };
	if (connected) {
		// Connected without a key: through its CLI (Copilot's gh) or a sign-in
		// (Claude, ChatGPT), whatever the registry also accepts.
		const registry = getRegistryProvider(providerId);
		if (registry?.requiresCLI) return { hasKey: true, authMethod: "cli" };
		if (registry?.requiresOAuth) return { hasKey: true, authMethod: "oauth" };
	}
	return { hasKey: false, authMethod };
}
