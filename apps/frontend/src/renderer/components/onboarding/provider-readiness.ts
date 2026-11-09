/**
 * Which AI providers can actually run a task once the setup wizard ends.
 *
 * The last screen of the wizard said « Setup Complete » whatever happened,
 * including after « Skip » on every step: the user then met a board whose
 * tasks could not start. It now asks the same source as the provider pickers
 * (`getStaticProviders`) and names what is connected, or says nothing is.
 */
import type { ProvidersResponse } from "../../../shared/utils/providers";
import type { APIProfile } from "../../../shared/types/profile";
import { detectProvider } from "../../../shared/utils/provider-detection";

/**
 * The labels of the providers ready to use, in the pickers' order.
 *
 * Ollama is reported as available by default (it is local), which says
 * nothing about a server running: it counts only once a URL or a profile
 * points at it. An API profile with a key counts too, under its own name,
 * when its endpoint is not one of the listed providers.
 */
export function readyProviderLabels(
	response: ProvidersResponse,
	profiles: readonly APIProfile[],
	settings: Readonly<Record<string, unknown>> = {},
): string[] {
	const withKey = profiles.filter((profile) => profile.apiKey?.trim());
	const ollamaConfigured =
		Boolean(String(settings.globalOllamaApiUrl ?? "").trim()) ||
		withKey.some((profile) => detectProvider(profile.baseUrl) === "ollama");

	const labels = response.providers
		.filter((provider) => response.status[provider.name] === true)
		.filter((provider) => provider.name !== "ollama" || ollamaConfigured)
		.map((provider) => provider.label);

	const listed = new Set(response.providers.map((provider) => provider.name));
	for (const profile of withKey) {
		const detected = profile.baseUrl ? detectProvider(profile.baseUrl) : "";
		if (!detected || !listed.has(detected)) labels.push(profile.name);
	}
	return [...new Set(labels)];
}
