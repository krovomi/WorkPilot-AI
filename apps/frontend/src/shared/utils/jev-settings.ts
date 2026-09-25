import type { JevSettings } from "../types/jev";
export function parseJevSettings(value: unknown): JevSettings {
	if (value === undefined) return { enabled: false };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("jev-invalid-settings");
	const v = value as Record<string, unknown>;
	if (typeof v.enabled !== "boolean") throw new Error("jev-invalid-settings");
	const result: JevSettings = { enabled: v.enabled };
	if (v.model !== undefined) {
		if (
			typeof v.model !== "string" ||
			!/^jev-[a-zA-Z0-9_.-]{1,75}$/.test(v.model)
		)
			throw new Error("jev-invalid-settings");
		result.model = v.model;
	}
	for (const [key, fallback, min, max] of [
		["minimumConfidence", 0.8, 0, 1],
		["timeoutSeconds", 5, Number.MIN_VALUE, 60],
	] as const) {
		const n = v[key] ?? fallback;
		if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
			throw new Error("jev-invalid-settings");
		result[key] = n;
	}
	if (v.workflows !== undefined) {
		if (
			!v.workflows ||
			typeof v.workflows !== "object" ||
			Array.isArray(v.workflows)
		)
			throw new Error("jev-invalid-settings");
		result.workflows = {};
		for (const [id, mode] of Object.entries(v.workflows)) {
			if (
				!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id) ||
				!["inherit", "enabled", "bypass"].includes(String(mode))
			)
				throw new Error("jev-invalid-settings");
			result.workflows[id] = mode as "inherit" | "enabled" | "bypass";
		}
	}
	return result;
}
