import type {
	OfflineModelCatalog,
	OfflinePolicy,
} from "../../preload/api/modules/offline-mode-api";

export const LOCAL_PROVIDERS = ["ollama", "lm-studio", "llama-cpp"] as const;

export function modelsForProvider(
	catalog: OfflineModelCatalog | null,
	provider: string,
): string[] {
	if (!LOCAL_PROVIDERS.some((p) => p === provider)) return [];
	return [...(catalog?.providers[provider] ?? [])].sort();
}

export function newLocalRoute(
	catalog: OfflineModelCatalog | null,
	provider: string,
) {
	const local = LOCAL_PROVIDERS.some((p) => p === provider)
		? provider
		: "ollama";
	return { provider: local, model: modelsForProvider(catalog, local)[0] ?? "" };
}

export function isValidOfflinePolicy(
	policy: OfflinePolicy,
	catalog: OfflineModelCatalog | null,
): boolean {
	return (
		!!catalog &&
		LOCAL_PROVIDERS.some((p) => p === policy.defaultProvider) &&
		(!policy.airgapStrict ||
			Object.values(policy.routing).some(
				(entry) => entry.provider === policy.defaultProvider,
			)) &&
		Object.values(policy.routing).every(
			(entry) =>
				!!entry.model &&
				modelsForProvider(catalog, entry.provider).includes(entry.model),
		)
	);
}

export function canSaveOfflinePolicy(
	policy: OfflinePolicy,
	catalog: OfflineModelCatalog | null,
	saved: OfflinePolicy | null,
): boolean {
	const disablingOnly =
		saved?.airgapStrict === true &&
		!policy.airgapStrict &&
		saved.defaultProvider === policy.defaultProvider &&
		JSON.stringify(saved.routing) === JSON.stringify(policy.routing);
	return disablingOnly || isValidOfflinePolicy(policy, catalog);
}
