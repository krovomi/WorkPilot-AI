/**
 * app.json, plus what only the build knows.
 *
 * A phone gets an Expo push token only for an EAS project: its id comes from
 * `EAS_PROJECT_ID` (or `eas init`, which writes it into app.json). Without
 * one the app works the same and simply does not register for notifications.
 * Android also needs the Firebase file of that project (`GOOGLE_SERVICES_JSON`,
 * a path); iOS gets its push key from EAS. See docs/architecture/mobile-app.md.
 */

import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
	const projectId = process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId;
	const googleServicesFile = process.env.GOOGLE_SERVICES_JSON || config.android?.googleServicesFile;
	return {
		...config,
		name: config.name ?? "WorkPilot AI",
		slug: config.slug ?? "workpilot-ai",
		android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
		extra: { ...config.extra, ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}) },
	};
};
