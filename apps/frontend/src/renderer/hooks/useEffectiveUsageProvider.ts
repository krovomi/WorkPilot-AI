import { detectProvider } from "@shared/utils/provider-detection";
import { useProviderContext } from "../components/ProviderContext";
import { useSettingsStore } from "../stores/settings-store";

/**
 * The provider whose usage the badge shows when nothing picked one.
 *
 * The context's provider stays empty until a provider is chosen, and only the
 * selector in Settings → General chooses one: on a first start the usage
 * badge waited for it on "Loading..." for good. Once settings are read, the
 * active API profile's provider answers, else Anthropic, as the auth badge
 * next to it does.
 */
export function resolveUsageProvider(
	usageProvider: string,
	settingsLoaded: boolean,
	activeProfileBaseUrl: string | undefined,
): string {
	if (usageProvider) return usageProvider;
	if (!settingsLoaded) return "";
	return activeProfileBaseUrl ? detectProvider(activeProfileBaseUrl) : "anthropic";
}

export function useEffectiveUsageProvider(): string {
	const { usageProvider } = useProviderContext();
	const settingsLoaded = useSettingsStore((s) => !s.isLoading);
	const activeBaseUrl = useSettingsStore(
		(s) => s.profiles.find((p) => p.id === s.activeProfileId)?.baseUrl,
	);
	return resolveUsageProvider(usageProvider, settingsLoaded, activeBaseUrl);
}
