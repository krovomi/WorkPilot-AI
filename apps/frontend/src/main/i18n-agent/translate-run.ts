/**
 * Translating the missing keys on a review card, never in the checkout (#346).
 *
 * A review card is opened (`openReviewRun`: a worktree on the card's own
 * branch), the i18n runner adds each locale's missing keys there, translated
 * by the active text model and checked placeholder by placeholder, and the card
 * is committed and put in review: the person reads the diff and opens the pull
 * request from the card. A run that added nothing takes its card away again.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import type { I18nTranslateOutcome, I18nTranslateRequest } from "../../shared/types/i18n-agent";
import { getAppLanguage } from "../app-language";
import { openReviewRun, type ReviewRun } from "../generated-review/review-run";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const TRANSLATE_PREFIX = "I18N_TRANSLATE:";
const ERROR_PREFIX = "I18N_ERROR:";
const LOCALE = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$/;
const MAX_LOCALES = 50;
const RUN_TIMEOUT_MS = 20 * 60_000;

/** The request as the renderer sent it, kept only where it is well formed (S6). */
export function readTranslateRequest(raw: unknown): I18nTranslateRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.projectPath !== "string" || !r.projectPath) return null;
	const reference = typeof r.referenceLocale === "string" ? r.referenceLocale : "en";
	if (!LOCALE.test(reference)) return null;
	const locales = Array.isArray(r.locales)
		? [...new Set(r.locales.filter((l): l is string => typeof l === "string" && LOCALE.test(l)))]
		: [];
	return { projectPath: r.projectPath, referenceLocale: reference, locales: locales.slice(0, MAX_LOCALES) };
}

export type TranslateOutput = Omit<I18nTranslateOutcome, "review">;
export type RunTranslator = (root: string, request: I18nTranslateRequest) => Promise<TranslateOutput>;

/** Runs `i18n_runner.py --translate` in `root` and returns what it added. */
export const runTranslator: RunTranslator = async (root, request) => {
	const { app } = await import("electron");
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runner = path.resolve(backendPath, "runners", "i18n_runner.py");
	const python = await requirePythonPath();
	const args = [runner, "--project-path", root, "--reference-locale", request.referenceLocale, "--translate"];
	if (request.locales.length) args.push("--locales", request.locales.join(","));
	const env = await pythonRunnerEnv(backendPath);
	return new Promise<TranslateOutput>((resolve, reject) => {
		const child = spawn(python, args, { cwd: backendPath, env });
		const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => console.error("[i18nAgent translate]", chunk.toString()));
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const lines = out.split("\n").map((l) => l.trim());
			const error = lines.find((l) => l.startsWith(ERROR_PREFIX));
			const result = lines.find((l) => l.startsWith(TRANSLATE_PREFIX));
			if (code !== 0 || !result) {
				reject(new Error(error?.slice(ERROR_PREFIX.length) || `i18n translator exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(result.slice(TRANSLATE_PREFIX.length)) as TranslateOutput);
			} catch (err) {
				reject(err);
			}
		});
	});
};

const SUMMARY = {
	en: (n: number, locales: string) =>
		`${n} missing translation${n === 1 ? "" : "s"} added from the i18n page (${locales}). Each kept its placeholders; read them before merging.`,
	fr: (n: number, locales: string) =>
		`${n} traduction${n === 1 ? "" : "s"} manquante${n === 1 ? "" : "s"} ajoutée${n === 1 ? "" : "s"} depuis la page i18n (${locales}). Chacune garde ses variables ; relisez-les avant de fusionner.`,
};

function safeOutput(output: TranslateOutput): TranslateOutput {
	const written = Array.isArray(output?.written)
		? output.written.filter(
				(w) => w && typeof w.file === "string" && typeof w.locale === "string" && Number.isFinite(w.count),
			)
		: [];
	return {
		added: written.reduce((n, w) => n + w.count, 0),
		written,
		rejected: Number.isFinite(output?.rejected) ? output.rejected : 0,
		skipped: Number.isFinite(output?.skipped) ? output.skipped : 0,
		answered: output?.answered === true,
		notWritable: Array.isArray(output?.notWritable)
			? output.notWritable.filter((f): f is string => typeof f === "string")
			: [],
	};
}

export async function translateOnReviewCard(
	request: I18nTranslateRequest,
	openRun: (projectPath: string, subject: string) => Promise<ReviewRun> = (p, subject) =>
		openReviewRun(p, "i18n", subject),
	translator: RunTranslator = runTranslator,
): Promise<I18nTranslateOutcome> {
	const subject = request.locales.length ? request.locales.join(", ") : "missing keys";
	const run = await openRun(request.projectPath, subject);
	try {
		const output = safeOutput(await translator(run.root, request));
		if (output.added === 0) {
			await run.abandon();
			return { ...output, review: null };
		}
		const locales = [...new Set(output.written.map((w) => w.locale))].sort().join(", ");
		const review = await run.finish({
			message: `feat(i18n): ${output.added} missing translation${output.added === 1 ? "" : "s"} (${locales})`.slice(0, 100),
			summary: SUMMARY[getAppLanguage() === "fr" ? "fr" : "en"](output.added, locales),
		});
		return { ...output, review: review.committed ? review : null };
	} catch (error) {
		await run.abandon().catch(() => undefined);
		throw error;
	}
}
