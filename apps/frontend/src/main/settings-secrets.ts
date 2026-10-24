/**
 * The app settings as the renderer may see and send them (rule S6). SETTINGS_GET
 * hands every set credential (isSecretSettingsKey) over as MASKED_SECRET, and
 * SETTINGS_SAVE reads the mask coming back as "keep the stored value": the
 * settings screens save the whole object on every edit.
 */
import { maskSecret, sameEndpoint, unmaskSecret } from "./utils/masked-secret";
import { isSecretSettingsKey } from "./settings-utils";

/** `settings` with every set secret replaced by the mask. */
export function maskSettingsSecrets<T extends object>(settings: T): T {
	const masked = { ...settings } as Record<string, unknown>;
	for (const [key, value] of Object.entries(masked)) {
		if (isSecretSettingsKey(key) && typeof value === "string") {
			masked[key] = maskSecret(value);
		}
	}
	return masked as T;
}

/**
 * `update` from the renderer, ready to merge over `current`: a masked secret is
 * dropped so it keeps its stored value, the text typed around a mask replaces it.
 * The custom provider key follows its URL: kept behind the mask, it is dropped
 * when the URL changes, so a stored key never goes to a host the renderer names.
 */
export function unmaskSettingsUpdate<T extends object>(
	update: Partial<T>,
	current: Partial<T>,
): Partial<T> {
	const result: Record<string, unknown> = { ...update };
	const stored = current as Record<string, unknown>;
	for (const [key, value] of Object.entries(result)) {
		if (!isSecretSettingsKey(key) || typeof value !== "string") continue;
		const typed = unmaskSecret(value);
		if (typed === undefined) delete result[key];
		else result[key] = typed;
	}
	const url = result.customProviderUrl;
	if (
		typeof url === "string" &&
		!("customProviderApiKey" in result) &&
		typeof stored.customProviderApiKey === "string" &&
		stored.customProviderApiKey !== "" &&
		!sameEndpoint(url, stored.customProviderUrl as string | undefined)
	) {
		result.customProviderApiKey = "";
	}
	return result as Partial<T>;
}
