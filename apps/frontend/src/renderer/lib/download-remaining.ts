import type { TFunction } from "i18next";

/**
 * "3m remaining", in the app's language, from the download store's seconds
 * (`common:downloads.*Remaining`). The store keeps the number only, so every
 * view words the estimate in the language the person chose.
 */
export function formatDownloadRemaining(seconds: number, t: TFunction): string {
	if (seconds > 3600) {
		return t("common:downloads.hoursRemaining", {
			count: Math.ceil(seconds / 3600),
		});
	}
	if (seconds > 60) {
		return t("common:downloads.minutesRemaining", {
			count: Math.ceil(seconds / 60),
		});
	}
	return t("common:downloads.secondsRemaining", { count: seconds });
}
