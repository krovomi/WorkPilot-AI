/**
 * The values the Self-Healing handlers receive from the renderer, checked in
 * the main before they reach the runner or the project's config file (rule
 * S6). The project folder itself is checked by `ipc-path-policy`.
 */

/** An incident id, as the backend makes them (12 hex characters), or a test's. */
const INCIDENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** An operation id: an incident id, possibly followed by more of the same. */
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED_KEYS = new Set(["constructor", "prototype"]);

export const SELF_HEALING_MODES = ["cicd", "production", "proactive"] as const;
/** The runner's `IncidentSource` values. */
export const INCIDENT_SOURCES = [
	"git_push",
	"ci_failure",
	"sentry",
	"datadog",
	"cloudwatch",
	"new_relic",
	"pagerduty",
	"proactive_scan",
] as const;

const MAX_CONFIG_KEYS = 50;
const MAX_TEXT = 2048;
const MAX_LIST = 100;

export const INVALID_INPUT = { success: false, error: "Invalid input" } as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function isText(value: unknown, max = MAX_TEXT): value is string {
	return typeof value === "string" && value.length <= max && !hasControlCharacter(value);
}

export function isIncidentId(value: unknown): value is string {
	return typeof value === "string" && INCIDENT_ID.test(value);
}

export function isOperationId(value: unknown): value is string {
	return typeof value === "string" && OPERATION_ID.test(value);
}

/** An optional incidents filter: undefined, or one of the three modes. */
export function isModeFilter(value: unknown): value is (typeof SELF_HEALING_MODES)[number] | undefined {
	return value === undefined || (SELF_HEALING_MODES as readonly unknown[]).includes(value);
}

export function isIncidentSource(value: unknown): value is (typeof INCIDENT_SOURCES)[number] {
	return (INCIDENT_SOURCES as readonly unknown[]).includes(value);
}

function isConfigValue(value: unknown): boolean {
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value === "string") return isText(value);
	return Array.isArray(value) && value.length <= MAX_LIST && value.every((item) => isText(item));
}

/**
 * A mode's settings as the page saves them: a flat object of booleans,
 * numbers, short texts and lists of texts, under plain names. Null otherwise.
 */
export function modeConfig(value: unknown): Record<string, unknown> | null {
	if (!isPlainObject(value)) return null;
	const entries = Object.entries(value);
	if (entries.length > MAX_CONFIG_KEYS) return null;
	for (const [key, item] of entries) {
		if (!CONFIG_KEY.test(key) || RESERVED_KEYS.has(key) || !isConfigValue(item)) return null;
	}
	return Object.fromEntries(entries);
}

export interface SourceConfig {
	source: (typeof INCIDENT_SOURCES)[number];
	server_url?: string;
	api_key?: string;
	project_id?: string;
	environment?: string;
}

/**
 * A production source to connect: a known source and the four fields the
 * runner reads, each a short text; `server_url` an http(s) URL when given.
 */
export function sourceConfig(value: unknown): SourceConfig | null {
	if (!isPlainObject(value) || !isIncidentSource(value.source)) return null;
	const config: SourceConfig = { source: value.source };
	for (const key of ["server_url", "api_key", "project_id", "environment"] as const) {
		const item = value[key];
		if (item === undefined || item === null || item === "") continue;
		if (!isText(item)) return null;
		config[key] = item;
	}
	if (config.server_url !== undefined) {
		let protocol: string;
		try {
			protocol = new URL(config.server_url).protocol;
		} catch {
			return null;
		}
		if (protocol !== "https:" && protocol !== "http:") return null;
	}
	return config;
}
