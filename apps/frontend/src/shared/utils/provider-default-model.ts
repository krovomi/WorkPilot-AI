/**
 * The one model a provider page names as the default: the local server's
 * model (Ollama, LM Studio…) or a gateway's (OpenRouter, Hugging Face). A task
 * on that provider starts every phase on it, unless Settings give the provider
 * its own per-phase models.
 */
import { gatewayProvider } from "../constants/gateway-providers";
import type { AppSettings } from "../types/settings";

export type ProviderDefaultModelSettings = Pick<
	AppSettings,
	"globalOllamaModel" | "globalOpenRouterModel" | "globalHuggingFaceModel"
>;

const LOCAL_PROVIDERS = new Set(["ollama", "local", "lmstudio"]);

/** The provider page's default model, trimmed, or undefined when none is set. */
export function providerDefaultModel(
	provider: string,
	settings: ProviderDefaultModelSettings | undefined,
): string | undefined {
	const gateway = gatewayProvider(provider);
	const value = LOCAL_PROVIDERS.has(provider)
		? settings?.globalOllamaModel
		: gateway
			? settings?.[gateway.modelSettingsKey]
			: undefined;
	return value?.trim() || undefined;
}
