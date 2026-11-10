/**
 * A notebook run and a notebook refactor (#371).
 *
 * Both name a notebook by its path relative to the project, checked here
 * (relative, no `..`, a notebook suffix) and again by the runner, which
 * resolves it inside the project (S4, S6).
 *
 * - `executeNotebook`: `notebook_agent_runner.py --action execute` runs the
 *   notebook in a fresh kernel; the executed copy goes to a temporary folder
 *   and the notebook is not changed. The runner gets no provider credentials.
 * - `refactorOnReviewCard`: the chosen cells become functions and the
 *   notebook is cleaned, on a review card (`openReviewRun`), never in the
 *   person's checkout. A run that changed nothing takes its card away.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type {
	NotebookExecution,
	NotebookMonth,
	NotebookRefactorOutcome,
	NotebookRefactorRequest,
	NotebookRunRequest,
} from "../../shared/types/notebook-agent";
import { getAppLanguage } from "../app-language";
import { openReviewRun, type ReviewRun } from "../generated-review/review-run";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const SUFFIXES = new Set([".ipynb", ".dib", ".qmd", ".rmd"]);
const MAX_EXTRACT = 50;
/** The runner stops the notebook at 30 min; this is the runner's own margin. */
export const EXECUTE_TIMEOUT_MS = 35 * 60_000;
const REFACTOR_TIMEOUT_MS = 2 * 60_000;
const ERROR_PREFIX = "NOTEBOOK_ERROR:";

/** A notebook path relative to the project, or null (S6). */
export function readNotebookPath(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw || raw.length > 500) return null;
	if (raw.includes("\0") || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
	const parts = raw.split(/[\\/]/);
	if (parts.some((part) => part === ".." || part === "") || parts[0] === ".workpilot") return null;
	return SUFFIXES.has(path.extname(raw).toLowerCase()) ? raw : null;
}

export function readRunRequest(raw: unknown): NotebookRunRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const notebook = readNotebookPath(r.notebook);
	if (typeof r.projectPath !== "string" || !r.projectPath || !notebook) return null;
	return { projectPath: r.projectPath, notebook };
}

export function readRefactorRequest(raw: unknown): NotebookRefactorRequest | null {
	const base = readRunRequest(raw);
	if (!base?.notebook.toLowerCase().endsWith(".ipynb")) return null;
	const r = raw as Record<string, unknown>;
	const extract = Array.isArray(r.extract)
		? [...new Set(r.extract.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 100_000))]
		: [];
	const clean = r.clean === true;
	if (extract.length === 0 && !clean) return null;
	return { ...base, extract: extract.slice(0, MAX_EXTRACT).sort((a, b) => a - b), clean };
}

export type RunNotebookRunner = <T>(args: string[], prefix: string, timeoutMs: number) => Promise<T>;

/** Runs `notebook_agent_runner.py` with `args` and returns its `prefix` line. */
export const runNotebookRunner: RunNotebookRunner = async <T>(
	args: string[],
	prefix: string,
	timeoutMs: number,
): Promise<T> => {
	const { app } = await import("electron");
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runner = path.resolve(backendPath, "runners", "notebook_agent_runner.py");
	const python = await requirePythonPath();
	const env = await pythonRunnerEnv(backendPath);
	return new Promise<T>((resolve, reject) => {
		const child = spawn(python, [runner, ...args], { cwd: backendPath, env });
		const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => console.error("[Notebook]", chunk.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const lines = out.split("\n").map((l) => l.trim());
			const error = lines.find((l) => l.startsWith(ERROR_PREFIX));
			const result = lines.find((l) => l.startsWith(prefix));
			if (code !== 0 || !result) {
				reject(new Error(error?.slice(ERROR_PREFIX.length) || `notebook runner exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(result.slice(prefix.length)) as T);
			} catch (err) {
				reject(err);
			}
		});
	});
};

export function executeNotebook(
	request: NotebookRunRequest,
	runner: RunNotebookRunner = runNotebookRunner,
): Promise<NotebookExecution> {
	return runner<NotebookExecution>(
		["--project-path", request.projectPath, "--action", "execute", "--notebook", request.notebook],
		"NOTEBOOK_EXECUTION:",
		EXECUTE_TIMEOUT_MS,
	);
}

export async function notebookMetrics(
	projectPath: string,
	runner: RunNotebookRunner = runNotebookRunner,
): Promise<NotebookMonth[]> {
	const result = await runner<{ months: NotebookMonth[] }>(
		["--project-path", projectPath, "--action", "metrics"],
		"NOTEBOOK_METRICS:",
		REFACTOR_TIMEOUT_MS,
	);
	return Array.isArray(result.months) ? result.months : [];
}

interface ApplyOutput {
	extracted: NotebookRefactorOutcome["extracted"];
	refused: NotebookRefactorOutcome["refused"];
	cleaned: boolean;
	changed: string[];
}

function commitMessage(name: string, extracted: number, cleaned: boolean): string {
	const parts = [extracted ? `extract ${extracted} cell${extracted === 1 ? "" : "s"} into functions` : "", cleaned ? "clean outputs" : ""];
	return `refactor(notebook): ${parts.filter(Boolean).join(", ")} in ${name}`.slice(0, 100);
}

const SUMMARY = {
	en: (n: number, cleaned: boolean) =>
		`${n} notebook cell${n === 1 ? "" : "s"} turned into functions${cleaned ? ", outputs cleaned" : ""}.`,
	fr: (n: number, cleaned: boolean) =>
		`${n} cellule${n === 1 ? "" : "s"} de notebook devenue${n === 1 ? "" : "s"} des fonctions${cleaned ? ", sorties nettoyées" : ""}.`,
};

export async function refactorOnReviewCard(
	request: NotebookRefactorRequest,
	openRun: (projectPath: string, subject: string) => Promise<ReviewRun> = (p, subject) =>
		openReviewRun(p, "notebook-agent", subject),
	runner: RunNotebookRunner = runNotebookRunner,
): Promise<NotebookRefactorOutcome> {
	const name = path.basename(request.notebook);
	const run = await openRun(request.projectPath, name);
	try {
		const args = ["--project-path", run.root, "--action", "apply", "--notebook", request.notebook];
		if (request.extract.length > 0) args.push("--extract", request.extract.join(","));
		if (request.clean) args.push("--clean");
		const output = await runner<ApplyOutput>(args, "NOTEBOOK_APPLY:", REFACTOR_TIMEOUT_MS);
		const extracted = Array.isArray(output.extracted) ? output.extracted : [];
		const refused = Array.isArray(output.refused) ? output.refused : [];
		const changed = Array.isArray(output.changed) ? output.changed : [];
		if (changed.length === 0) {
			await run.abandon();
			return { extracted, refused, cleaned: false, review: null };
		}
		const review = await run.finish({
			message: commitMessage(name, extracted.length, output.cleaned === true),
			summary: SUMMARY[getAppLanguage() === "fr" ? "fr" : "en"](extracted.length, output.cleaned === true),
		});
		return { extracted, refused, cleaned: output.cleaned === true, review: review.committed ? review : null };
	} catch (error) {
		await run.abandon().catch(() => undefined);
		throw error;
	}
}
