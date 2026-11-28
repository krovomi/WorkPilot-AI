/**
 * The tickets ranked by meaning, for « Interroger le tableau »
 * (docs/architecture/board-ask.md): the backend's
 * `runners/board_ask_embed_runner.py` asks an embeddings model (one on this
 * machine first, else the chosen provider's API) and answers how close each
 * ticket is to the question, whatever language either is written in.
 *
 * The runner gets the provider's environment from `pythonRunnerEnv` (S1: no
 * inherited credential), its input in a temporary file, and a folder of the
 * app's own for its vectors, never a project's. What it prints is read back
 * field by field (zod) and only for the ticket ids it was given. Any failure
 * (no Python, a timeout, no model) is `null`: the panel ranks by keywords.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { z } from "zod";
import type { AppSettings, BoardAskSemanticMode } from "../../shared/types";
import { BOARD_ASK_SEMANTIC_MODES } from "../../shared/types/board-ask";
import { appLog } from "../app-logger";
import { parsePythonCommand } from "../python-detector";
import { readSettingsFile } from "../settings-utils";
import { readyPythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

export const EMBED_RUNNER = "board_ask_embed_runner.py";
export const SEMANTIC_MARKER = "__BOARD_ASK_SEMANTIC__:";
/** The runner gives itself 30 s with the model; this leaves it room to save. */
const RUNNER_TIMEOUT_MS = 45_000;
const MAX_STDOUT = 4 * 1024 * 1024;
export const MAX_SEMANTIC_DOCUMENTS = 1500;

export interface SemanticDocument {
	id: string;
	text: string;
}

export interface SemanticRanking {
	source: { kind: "local" | "cloud"; provider: string; model: string };
	/** Best first, only the tickets the model read. */
	scores: { id: string; score: number }[];
	indexed: number;
	total: number;
}

/** The ranking of *documents* for *query*, or null when no model could be asked. */
export type SemanticFn = (query: string, documents: readonly SemanticDocument[]) => Promise<SemanticRanking | null>;

/**
 * A ranking of the same *documents* per query, in their order (null for a
 * query the model gave no vector for), or null when no model could be asked.
 */
export type SemanticManyFn = (
	queries: readonly string[],
	documents: readonly SemanticDocument[],
) => Promise<(SemanticRanking | null)[] | null>;

/** Queries one runner call takes (`board_ask.semantic.MAX_QUERIES`). */
export const MAX_SEMANTIC_QUERIES = 16;

const name = z.string().min(1).max(200);
const OutputSchema = z.object({
	source: z.object({ kind: z.enum(["local", "cloud"]), provider: name, model: name }).nullable(),
	scores: z.array(z.object({ id: z.string().max(200), score: z.number().finite() })).max(MAX_SEMANTIC_DOCUMENTS),
	indexed: z.number().int().nonnegative().optional(),
	total: z.number().int().nonnegative().optional(),
});

const ManySchema = z.object({
	source: OutputSchema.shape.source,
	rankings: z.array(z.object({ scores: OutputSchema.shape.scores }).nullable()).max(MAX_SEMANTIC_QUERIES),
	indexed: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
});

function markerJson(stdout: string): unknown {
	const line = stdout
		.split(/\r?\n/)
		.reverse()
		.find((l) => l.startsWith(SEMANTIC_MARKER));
	if (!line) return undefined;
	try {
		return JSON.parse(line.slice(SEMANTIC_MARKER.length));
	} catch {
		return undefined;
	}
}

type Scores = z.infer<typeof OutputSchema>["scores"];

function keptScores(scores: Scores, ids: ReadonlySet<string>): Scores {
	const seen = new Set<string>();
	const kept = scores.filter((s) => ids.has(s.id) && !seen.has(s.id) && seen.add(s.id));
	return kept.sort((a, b) => b.score - a.score);
}

/** The ranking in the runner's output, kept to the ids asked, or null. */
export function parseSemanticOutput(stdout: string, ids: ReadonlySet<string>): SemanticRanking | null {
	const parsed = OutputSchema.safeParse(markerJson(stdout));
	if (!parsed.success || !parsed.data.source) return null;
	const scores = keptScores(parsed.data.scores, ids);
	if (scores.length === 0) return null;
	return {
		source: parsed.data.source,
		scores,
		indexed: Math.min(parsed.data.indexed ?? scores.length, ids.size),
		total: Math.min(parsed.data.total ?? ids.size, ids.size),
	};
}

/** One ranking per query asked, from the runner's output, or null. */
export function parseSemanticRankings(
	stdout: string,
	ids: ReadonlySet<string>,
	queries: number,
): (SemanticRanking | null)[] | null {
	const parsed = ManySchema.safeParse(markerJson(stdout));
	if (!parsed.success || !parsed.data.source || parsed.data.rankings.length !== queries) return null;
	const { source } = parsed.data;
	const indexed = Math.min(parsed.data.indexed, ids.size);
	const total = Math.min(parsed.data.total, ids.size);
	const rankings = parsed.data.rankings.map((ranking) => {
		const scores = ranking ? keptScores(ranking.scores, ids) : [];
		return scores.length > 0 ? { source, scores, indexed, total } : null;
	});
	return rankings.some(Boolean) ? rankings : null;
}

/** The mode in the settings, `auto` when it names none. */
export function semanticMode(settings: Partial<AppSettings> | undefined): BoardAskSemanticMode {
	const value = settings?.boardAskSemantic;
	return BOARD_ASK_SEMANTIC_MODES.find((mode) => mode === value) ?? "auto";
}

export function readSemanticMode(): BoardAskSemanticMode {
	try {
		return semanticMode((readSettingsFile() ?? {}) as Partial<AppSettings>);
	} catch {
		return "auto";
	}
}

function backendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

/** The runner's input in, its stdout out, or null when it could not run. */
export type EmbedRunner = (input: Record<string, unknown>) => Promise<string | null>;

export const runEmbedRunner: EmbedRunner = async (input) => {
	const pythonPath = await readyPythonPath();
	if (!pythonPath) return null;
	const backend = backendPath();
	const env = await pythonRunnerEnv(backend);
	const dir = mkdtempSync(path.join(tmpdir(), "wp-board-ask-"));
	const inputFile = path.join(dir, "input.json");
	writeFileSync(inputFile, JSON.stringify(input), { encoding: "utf-8", mode: 0o600 });
	const [exe, baseArgs] = parsePythonCommand(pythonPath);
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exe, [...baseArgs, path.join(backend, "runners", EMBED_RUNNER), "--input", inputFile], {
				cwd: backend,
				env,
			});
		} catch (error) {
			cleanup();
			appLog.debug("[BoardAsk] embeddings runner did not start", error);
			resolve(null);
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
		}, RUNNER_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_STDOUT) stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			appLog.debug("[BoardAsk]", chunk.toString("utf-8").trim().slice(0, 500));
		});
		child.on("error", () => {
			clearTimeout(timer);
			cleanup();
			resolve(null);
		});
		child.on("close", () => {
			clearTimeout(timer);
			cleanup();
			resolve(stdout);
		});
	});
};

export interface SemanticSearchOptions {
	projectDir: string;
	mode: BoardAskSemanticMode;
	/** The app's folder for the vectors; `<userData>/board-ask` by default. */
	cacheDir?: string;
	run?: EmbedRunner;
}

/** The ranking function of several queries at once, or undefined when the mode is `off`. */
export function createSemanticRankings(options: SemanticSearchOptions): SemanticManyFn | undefined {
	if (options.mode === "off") return undefined;
	const run = options.run ?? runEmbedRunner;
	return async (queries, documents) => {
		const docs = documents.slice(0, MAX_SEMANTIC_DOCUMENTS);
		const asked = queries.map((q) => q.trim()).filter(Boolean);
		if (asked.length === 0 || asked.length > MAX_SEMANTIC_QUERIES || asked.length !== queries.length || docs.length === 0) {
			return null;
		}
		const stdout = await run({
			mode: options.mode,
			cache_dir: options.cacheDir ?? path.join(app.getPath("userData"), "board-ask"),
			project_dir: options.projectDir,
			queries: asked,
			documents: docs,
		}).catch(() => null);
		return stdout ? parseSemanticRankings(stdout, new Set(docs.map((d) => d.id)), asked.length) : null;
	};
}

/** The ranking function of one question, or undefined when the mode is `off`. */
export function createSemanticSearch(options: SemanticSearchOptions): SemanticFn | undefined {
	if (options.mode === "off") return undefined;
	const run = options.run ?? runEmbedRunner;
	return async (query, documents) => {
		const docs = documents.slice(0, MAX_SEMANTIC_DOCUMENTS);
		if (!query.trim() || docs.length === 0) return null;
		const stdout = await run({
			mode: options.mode,
			cache_dir: options.cacheDir ?? path.join(app.getPath("userData"), "board-ask"),
			project_dir: options.projectDir,
			query,
			documents: docs,
		}).catch(() => null);
		return stdout ? parseSemanticOutput(stdout, new Set(docs.map((d) => d.id))) : null;
	};
}
