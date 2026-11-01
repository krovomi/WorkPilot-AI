/**
 * The project's index (`.workpilot/project_index.json`, written by the
 * analyzer, `analysis/analyzers/project_analyzer_module.py`) and the
 * memories of its brain, read defensively: a field missing or of the wrong
 * type is left out rather than drawn, and every list is bounded.
 */

export const INDEX_FILE = "project_index.json";
const MAX_SERVICES = 40;
const MAX_ITEMS = 20;

export interface IndexService {
	name: string;
	path: string | null;
	/** Language, framework, type and the tools it uses, as short labels. */
	labels: string[];
	port: number | null;
}

export interface IndexFact {
	key: string;
	value: string;
}

export interface ContextIndex {
	projectType: string | null;
	services: IndexService[];
	infrastructure: IndexFact[];
	conventions: IndexFact[];
}

/** A memory as `/api/features/context/memories` serves it (already redacted). */
export interface Memory {
	id: string;
	type: string;
	timestamp?: string;
	content: string;
	session_number?: number | null;
	score?: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function list(value: unknown): string | null {
	if (!Array.isArray(value)) return text(value);
	const items = value.map(text).filter((v): v is string => !!v);
	if (!items.length) return null;
	const shown = items.slice(0, MAX_ITEMS).join(", ");
	return items.length > MAX_ITEMS ? `${shown}, +${items.length - MAX_ITEMS}` : shown;
}

/** The keys shown, in this order; anything else in the file is not. */
const INFRASTRUCTURE = ["docker_compose", "docker_services", "dockerfile", "dockerfiles", "ci", "ci_workflows", "deployment"];
const CONVENTIONS = ["python_linting", "python_formatting", "js_linting", "formatting", "typescript", "git_hooks"];

function facts(section: unknown, keys: string[]): IndexFact[] {
	if (!isObject(section)) return [];
	const out: IndexFact[] = [];
	for (const key of keys) {
		const raw = section[key];
		const value = typeof raw === "boolean" ? (raw ? "✓" : null) : list(raw);
		if (value) out.push({ key, value });
	}
	return out;
}

function service(key: string, raw: unknown): IndexService | null {
	if (!isObject(raw)) return null;
	const labels = [raw.language, raw.framework, raw.type, raw.package_manager, raw.testing]
		.map(text)
		.filter((v): v is string => !!v && v !== "unknown");
	const port = typeof raw.default_port === "number" && Number.isInteger(raw.default_port) ? raw.default_port : null;
	return { name: text(raw.name) ?? key, path: text(raw.path), labels, port };
}

/** The index file's content as the screen shows it; null when it is missing or not JSON. */
export function readIndex(content: string | undefined): ContextIndex | null {
	if (!content) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	if (!isObject(parsed)) return null;
	const services = isObject(parsed.services)
		? Object.entries(parsed.services)
				.slice(0, MAX_SERVICES)
				.map(([key, raw]) => service(key, raw))
				.filter((s): s is IndexService => !!s)
		: [];
	return {
		projectType: text(parsed.project_type),
		services,
		infrastructure: facts(parsed.infrastructure, INFRASTRUCTURE),
		conventions: facts(parsed.conventions, CONVENTIONS),
	};
}
