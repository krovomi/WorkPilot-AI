/**
 * Cross-Language Translation Agent IPC Handlers (Feature 41)
 *
 * Exposes channels for AI-powered code translation between programming languages:
 *   crossLangTranslation:getSupportedLanguages — List of supported source/target languages
 *   crossLangTranslation:translate             — Translate a pasted snippet
 *   crossLangTranslation:cancel                — Cancel an in-progress translation
 *   crossLangTranslation:getHistory            — List recent translations
 *   crossLangTranslation:clearHistory          — Clear translation history
 *
 * The runner (`apps/backend/runners/cross_language_translation_runner.py`)
 * answers with one marker per stdout line (`__DELTA__:`, `__RESULT__:`,
 * `__ERROR__:`); only the model's text is streamed to the page.
 *
 * The renderer sends code, never a path to read or write: the snippet goes to
 * a private temporary file the main process creates and removes.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import { parsePythonCommand } from "../python-detector";
import { getConfiguredPythonPath } from "../python-env-manager";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const RUNNER = "cross_language_translation_runner.py";

/** The backend folder: bundled resources once packaged, `apps/backend` in dev. */
export function resolveBackendPath(): string {
	return app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
}

export function getRunnerPath(): string {
	return path.join(resolveBackendPath(), "runners", RUNNER);
}

export interface TranslationResult {
	translated_code: string;
	test_code?: string | null;
	source_lang?: string;
	target_lang?: string;
	lines_translated?: number;
	lines_output?: number;
}

export type RunnerLine =
	| { kind: "delta"; text: string }
	| { kind: "result"; result: TranslationResult }
	| { kind: "error"; message: string; code: string }
	| { kind: "status"; status: string };

const DELTA_MARKER = "__DELTA__:";
const RESULT_MARKER = "__RESULT__:";
const ERROR_MARKER = "__ERROR__:";
const STATUS_MARKER = "__STATUS__:";

/** One stdout line of the runner, or null for anything else (logs). */
export function parseRunnerLine(line: string): RunnerLine | null {
	const trimmed = line.trim();
	try {
		if (trimmed.startsWith(DELTA_MARKER)) {
			const text = JSON.parse(trimmed.slice(DELTA_MARKER.length));
			return typeof text === "string" ? { kind: "delta", text } : null;
		}
		if (trimmed.startsWith(RESULT_MARKER)) {
			const result = JSON.parse(trimmed.slice(RESULT_MARKER.length));
			if (result && typeof result.translated_code === "string") {
				return { kind: "result", result };
			}
			return null;
		}
		if (trimmed.startsWith(ERROR_MARKER)) {
			const err = JSON.parse(trimmed.slice(ERROR_MARKER.length));
			return {
				kind: "error",
				message: String(err?.message ?? "Translation failed"),
				code: String(err?.code ?? "unknown"),
			};
		}
	} catch {
		return null;
	}
	if (trimmed.startsWith(STATUS_MARKER)) {
		return { kind: "status", status: trimmed.slice(STATUS_MARKER.length) };
	}
	return null;
}

let _currentProcess: ChildProcess | null = null;
let _cancelled = false;

type RunOutcome =
	| { success: true; data: TranslationResult }
	| { success: false; error: string; cancelled?: boolean };

async function runRunner(
	projectDir: string,
	args: string[],
	onDelta: (text: string) => void,
): Promise<RunOutcome> {
	if (_currentProcess) {
		_currentProcess.kill("SIGTERM");
		_currentProcess = null;
	}
	_cancelled = false;

	const backendPath = resolveBackendPath();
	const [cmd, pythonBaseArgs] = parsePythonCommand(getConfiguredPythonPath());
	const cmdArgs = [...pythonBaseArgs, getRunnerPath(), ...args];
	const env = await pythonRunnerEnv(backendPath, {
		extra: { PYTHONUNBUFFERED: "1" },
	});

	return new Promise((resolve) => {
		const proc = spawn(cmd, cmdArgs, { env, cwd: projectDir });
		_currentProcess = proc;
		let buffer = "";
		let stderrTail = "";
		let result: TranslationResult | null = null;
		let reported: string | null = null;

		const handleLine = (line: string) => {
			const parsed = parseRunnerLine(line);
			if (!parsed) return;
			if (parsed.kind === "delta") onDelta(parsed.text);
			else if (parsed.kind === "result") result = parsed.result;
			else if (parsed.kind === "error") reported = parsed.message;
		};

		proc.stdout?.on("data", (d: Buffer) => {
			buffer += d.toString("utf-8");
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				handleLine(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
			}
		});
		proc.stderr?.on("data", (d: Buffer) => {
			stderrTail = (stderrTail + d.toString("utf-8")).slice(-4000);
		});

		proc.on("close", (code) => {
			if (buffer) handleLine(buffer);
			if (proc === _currentProcess) _currentProcess = null;
			if (result) {
				resolve({ success: true, data: result });
			} else if (_cancelled) {
				resolve({ success: false, error: "cancelled", cancelled: true });
			} else if (reported) {
				resolve({ success: false, error: reported });
			} else {
				const tail = stderrTail.trim().split("\n").slice(-3).join(" ");
				resolve({
					success: false,
					error: `exit ${code ?? "?"}${tail ? ` — ${tail}` : ""}`,
				});
			}
		});
		proc.on("error", (err) => {
			if (proc === _currentProcess) _currentProcess = null;
			resolve({ success: false, error: err.message });
		});
	});
}

const SUPPORTED_LANGUAGES = [
	{ id: "python", label: "Python", extension: ".py" },
	{ id: "typescript", label: "TypeScript", extension: ".ts" },
	{ id: "javascript", label: "JavaScript", extension: ".js" },
	{ id: "go", label: "Go", extension: ".go" },
	{ id: "java", label: "Java", extension: ".java" },
	{ id: "csharp", label: "C#", extension: ".cs" },
	{ id: "rust", label: "Rust", extension: ".rs" },
	{ id: "kotlin", label: "Kotlin", extension: ".kt" },
	{ id: "swift", label: "Swift", extension: ".swift" },
	{ id: "php", label: "PHP", extension: ".php" },
];

const LANGUAGE_IDS = new Set(SUPPORTED_LANGUAGES.map((l) => l.id));

type HistoryStatus = "pending" | "complete" | "failed" | "cancelled";

interface HistoryEntry {
	id: string;
	started_at: string;
	completed_at?: string;
	source_lang: string;
	target_lang: string;
	lines?: number;
	status: HistoryStatus;
}

function getHistoryPath(projectDir: string): string {
	return path.join(projectDir, ".workpilot", "translation_history.json");
}

function loadHistory(projectDir: string): HistoryEntry[] {
	const p = getHistoryPath(projectDir);
	if (!fs.existsSync(p)) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function saveHistory(projectDir: string, history: HistoryEntry[]): void {
	fs.mkdirSync(path.dirname(getHistoryPath(projectDir)), { recursive: true });
	fs.writeFileSync(
		getHistoryPath(projectDir),
		JSON.stringify(history.slice(0, 100), null, 2),
		"utf-8",
	);
}

function updateHistory(
	projectDir: string,
	id: string,
	patch: Partial<HistoryEntry>,
): void {
	const history = loadHistory(projectDir);
	const entry = history.find((h) => h.id === id);
	if (!entry) return;
	Object.assign(entry, patch);
	saveHistory(projectDir, history);
}

interface TranslateParams {
	projectDir: string;
	sourceLang: string;
	targetLang: string;
	code: string;
	preserveComments?: boolean;
	generateTests?: boolean;
}

export function registerCrossLanguageTranslationHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.CROSS_LANG_TRANSLATION_GET_SUPPORTED_LANGUAGES, () => ({
		success: true,
		data: SUPPORTED_LANGUAGES,
	}));

	ipcMain.handle(
		IPC_CHANNELS.CROSS_LANG_TRANSLATION_TRANSLATE,
		async (event, params: TranslateParams) => {
			if (
				!LANGUAGE_IDS.has(params?.sourceLang) ||
				!LANGUAGE_IDS.has(params?.targetLang)
			) {
				return { success: false, error: "Unsupported language" };
			}
			if (typeof params.code !== "string" || !params.code.trim()) {
				return { success: false, error: "Nothing to translate" };
			}

			const ext =
				SUPPORTED_LANGUAGES.find((l) => l.id === params.sourceLang)
					?.extension ?? ".txt";
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-translate-"));
			const sourceFile = path.join(tempDir, `source${ext}`);
			fs.writeFileSync(sourceFile, params.code, "utf-8");

			const entry: HistoryEntry = {
				id: Date.now().toString(),
				started_at: new Date().toISOString(),
				source_lang: params.sourceLang,
				target_lang: params.targetLang,
				lines: params.code.replace(/\n+$/, "").split("\n").length,
				status: "pending",
			};
			saveHistory(params.projectDir, [entry, ...loadHistory(params.projectDir)]);

			const args = [
				"--source-lang",
				params.sourceLang,
				"--target-lang",
				params.targetLang,
				"--project",
				params.projectDir,
				"--file",
				sourceFile,
				...(params.preserveComments ? ["--preserve-comments"] : []),
				...(params.generateTests ? ["--generate-tests"] : []),
			];

			let result: RunOutcome;
			try {
				result = await runRunner(params.projectDir, args, (text) => {
					if (!event.sender.isDestroyed()) {
						event.sender.send(IPC_CHANNELS.CROSS_LANG_TRANSLATION_STREAM_CHUNK, text);
					}
				});
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}

			updateHistory(params.projectDir, entry.id, {
				status: result.success
					? "complete"
					: result.cancelled
						? "cancelled"
						: "failed",
				completed_at: new Date().toISOString(),
			});

			return result;
		},
	);

	ipcMain.handle(IPC_CHANNELS.CROSS_LANG_TRANSLATION_CANCEL, () => {
		if (_currentProcess) {
			_cancelled = true;
			_currentProcess.kill("SIGTERM");
			_currentProcess = null;
			return { success: true };
		}
		return { success: false, error: "No translation in progress" };
	});

	ipcMain.handle(
		IPC_CHANNELS.CROSS_LANG_TRANSLATION_GET_HISTORY,
		(_event, projectDir: string, limit: number = 50) => {
			try {
				const history = loadHistory(projectDir).slice(0, limit);
				return { success: true, data: history };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);

	ipcMain.handle(
		IPC_CHANNELS.CROSS_LANG_TRANSLATION_CLEAR_HISTORY,
		(_event, projectDir: string) => {
			try {
				const p = getHistoryPath(projectDir);
				if (fs.existsSync(p)) {
					fs.unlinkSync(p);
				}
				return { success: true };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);
}
