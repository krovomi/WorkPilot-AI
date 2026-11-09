/**
 * The engine of an orchestration: the Provider × LLM × Effort, phase by phase,
 * that every repository's Kanban task gets (`shared/utils/task-engine.ts`).
 *
 * It lives in `engine.json` beside the manifest, not in it: the Python runner
 * rewrites `multi_repo_manifest.json` from its own dataclass at `analyze` and
 * `check`, and would drop a field it does not know. Absent = each task takes
 * its project's provider, then the default provider in Settings, as a task
 * created from the board does.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EngineTrio, TaskEngine } from "../../shared/types";
import { ENGINE_PHASES } from "../../shared/utils/task-engine";

export const ENGINE_FILE = "engine.json";

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFORTS: readonly string[] = ["none", "low", "medium", "high", "ultrathink"];
const MAX_MODEL_CHARS = 200;

function parseTrio(raw: unknown): EngineTrio | null {
	if (!raw || typeof raw !== "object") return null;
	const { provider, model, effort } = raw as Record<string, unknown>;
	if (typeof provider !== "string" || !PROVIDER.test(provider)) return null;
	if (
		typeof model !== "string" ||
		!model.trim() ||
		model.length > MAX_MODEL_CHARS ||
		[...model].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	) {
		return null;
	}
	if (typeof effort !== "string" || !EFFORTS.includes(effort)) return null;
	return { provider, model: model.trim(), effort } as EngineTrio;
}

/**
 * An engine from the renderer (not trusted, S6) or from disk: `null` when
 * there is none, `"invalid"` when one is given but a phase is malformed.
 */
export function parseTaskEngine(raw: unknown): TaskEngine | null | "invalid" {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
	const engine = {} as TaskEngine;
	for (const phase of ENGINE_PHASES) {
		const trio = parseTrio((raw as Record<string, unknown>)[phase]);
		if (!trio) return "invalid";
		engine[phase] = trio;
	}
	return engine;
}

export function writeEngine(dir: string, engine: TaskEngine): void {
	const file = path.join(dir, ENGINE_FILE);
	const partial = `${file}.partial`;
	writeFileSync(partial, JSON.stringify(engine, null, 2), "utf-8");
	renameSync(partial, file);
}

/** The engine recorded for the orchestration in `dir`; `null` when none is. */
export function readEngine(dir: string): TaskEngine | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path.join(dir, ENGINE_FILE), "utf-8"));
	} catch {
		return null;
	}
	const engine = parseTaskEngine(raw);
	return engine === "invalid" ? null : engine;
}
