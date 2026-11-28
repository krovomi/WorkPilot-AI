/**
 * The team's captures settings in `.workpilot/.env` (`CAPTURES_*`), read and
 * written for the project settings screen (`env-handlers.ts`).
 *
 * The renderer is not trusted: every value is put back in the shape
 * `pr_captures/settings.py` accepts before it is written, so a value can
 * never add a line to the file (no line break survives) nor name a branch
 * the backend would refuse.
 */

import type { ProjectCapturesConfig } from "../../shared/types/project";

const MODES = ["auto", "always", "never"] as const;
const PUBLISH = ["auto", "review", "never"] as const;
/** `pr_captures/settings.py`: 30 selectors of 200 characters at most. */
export const MAX_SELECTORS = 30;
export const MAX_SELECTOR_CHARS = 200;
const BRANCH =
	/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}){0,2}$/;
export const DEFAULT_CAPTURES_BRANCH = "workpilot-captures";

export const CAPTURES_ENV_KEYS = [
	"CAPTURES_MODE",
	"CAPTURES_COMPARE",
	"CAPTURES_MASK",
	"CAPTURES_MASK_SELECTORS",
	"CAPTURES_PUBLISH",
	"CAPTURES_PUBLISH_UNCHECKED",
	"CAPTURES_RETENTION_DAYS",
	"CAPTURES_BRANCH",
] as const;

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: undefined;
}

function flag(value: string | undefined, fallback: boolean): boolean {
	const text = value?.trim().toLowerCase();
	if (text && ["1", "true", "yes", "on"].includes(text)) return true;
	if (text && ["0", "false", "no", "off"].includes(text)) return false;
	return fallback;
}

/** Selectors as one line: split on commas, each bounded, no line break, no quote. */
export function cleanSelectors(value: unknown): string {
	if (typeof value !== "string") return "";
	const found: string[] = [];
	for (const part of value.replace(/[\r\n\0"']/g, " ").split(",")) {
		const selector = part.trim();
		if (!selector || selector.length > MAX_SELECTOR_CHARS || found.includes(selector)) {
			continue;
		}
		found.push(selector);
		if (found.length >= MAX_SELECTORS) break;
	}
	return found.join(",");
}

export function cleanBranch(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text) return "";
	if (!BRANCH.test(text) || text.includes("..") || text.endsWith(".lock") || text.endsWith(".")) {
		return undefined;
	}
	return text;
}

function cleanDays(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3650
		? value
		: undefined;
}

/** The settings as the screen shows them: defaults filled in. */
export function capturesFromEnv(vars: Record<string, string | undefined>): Required<ProjectCapturesConfig> {
	const days = Number.parseInt(vars.CAPTURES_RETENTION_DAYS ?? "", 10);
	return {
		mode: oneOf(vars.CAPTURES_MODE?.trim().toLowerCase(), MODES) ?? "auto",
		compare: flag(vars.CAPTURES_COMPARE, true),
		mask: flag(vars.CAPTURES_MASK, true),
		maskSelectors: cleanSelectors(vars.CAPTURES_MASK_SELECTORS ?? ""),
		publish: oneOf(vars.CAPTURES_PUBLISH?.trim().toLowerCase(), PUBLISH) ?? "auto",
		publishUnchecked: flag(vars.CAPTURES_PUBLISH_UNCHECKED, false),
		retentionDays: cleanDays(days) ?? 30,
		branch: cleanBranch(vars.CAPTURES_BRANCH ?? "") || DEFAULT_CAPTURES_BRANCH,
	};
}

/**
 * Write the fields the screen sent into `vars` (the file's variables),
 * leaving out anything that does not have the backend's shape. An empty
 * selector list or the default branch removes the key.
 */
export function applyCapturesToEnv(
	vars: Record<string, string>,
	config: ProjectCapturesConfig | undefined,
): void {
	if (!config || typeof config !== "object") return;
	const mode = oneOf(config.mode, MODES);
	if (mode) vars.CAPTURES_MODE = mode;
	const publish = oneOf(config.publish, PUBLISH);
	if (publish) vars.CAPTURES_PUBLISH = publish;
	if (typeof config.compare === "boolean") vars.CAPTURES_COMPARE = String(config.compare);
	if (typeof config.mask === "boolean") vars.CAPTURES_MASK = String(config.mask);
	if (typeof config.publishUnchecked === "boolean") {
		vars.CAPTURES_PUBLISH_UNCHECKED = String(config.publishUnchecked);
	}
	const days = cleanDays(config.retentionDays);
	if (days !== undefined) vars.CAPTURES_RETENTION_DAYS = String(days);
	if (config.maskSelectors !== undefined) {
		const selectors = cleanSelectors(config.maskSelectors);
		if (selectors) vars.CAPTURES_MASK_SELECTORS = selectors;
		else delete vars.CAPTURES_MASK_SELECTORS;
	}
	if (config.branch !== undefined) {
		const branch = cleanBranch(config.branch);
		if (branch === "" || branch === DEFAULT_CAPTURES_BRANCH) delete vars.CAPTURES_BRANCH;
		else if (branch) vars.CAPTURES_BRANCH = branch;
	}
}

/** The template's lines: a set key as written, an unset one as a comment with its default. */
export function capturesTemplateLines(vars: Record<string, string>): string {
	const defaults: Record<(typeof CAPTURES_ENV_KEYS)[number], string> = {
		CAPTURES_MODE: "auto",
		CAPTURES_COMPARE: "true",
		CAPTURES_MASK: "true",
		CAPTURES_MASK_SELECTORS: "",
		CAPTURES_PUBLISH: "auto",
		CAPTURES_PUBLISH_UNCHECKED: "false",
		CAPTURES_RETENTION_DAYS: "30",
		CAPTURES_BRANCH: DEFAULT_CAPTURES_BRANCH,
	};
	return CAPTURES_ENV_KEYS.map((key) =>
		vars[key] ? `${key}=${vars[key]}` : `# ${key}=${defaults[key]}`,
	).join("\n");
}
