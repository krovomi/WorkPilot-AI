/**
 * One-click accessibility fixes, made on a review card, never in the checkout (#391).
 *
 * The page names the fixes it wants by the ids of the last scan. A review
 * card is opened (`openReviewRun`: a worktree on the card's own branch), the
 * runner re-scans that worktree and makes the fixes it still finds there, and
 * the card is committed and put in review: the person reads the diff and
 * opens the pull request from the card. A run that changed nothing takes its
 * card away again.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { A11yFixOutcome, A11yFixRequest } from "../../shared/types/accessibility";
import { openReviewRun, type ReviewRun } from "../generated-review/review-run";
import { getAppLanguage } from "../app-language";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const FIX_PREFIX = "A11Y_FIX:";
const ERROR_PREFIX = "A11Y_ERROR:";
const MAX_FIXES = 500;
const FIX_ID = /^[a-z][a-z-]{1,40}:[^\0]{1,400}:\d{1,7}:\d{1,8}$/;
const LANG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
const RUN_TIMEOUT_MS = 5 * 60_000;

/** The request as the renderer sent it, kept only where it is well formed (S6). */
export function readFixRequest(raw: unknown): A11yFixRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.projectPath !== "string" || !r.projectPath) return null;
	const ids = Array.isArray(r.fixIds)
		? [...new Set(r.fixIds.filter((id): id is string => typeof id === "string" && FIX_ID.test(id)))]
		: [];
	if (ids.length === 0) return null;
	const lang = typeof r.pageLang === "string" && LANG.test(r.pageLang) ? r.pageLang : "en";
	return { projectPath: r.projectPath, fixIds: ids.slice(0, MAX_FIXES), pageLang: lang, aiAlt: r.aiAlt === true };
}

export interface FixRunnerOutput {
	readonly applied: { fixId: string; ruleId: string; file: string; line: number; attribute: string; value: string }[];
	readonly missing: string[];
	readonly aiAlt: number;
}

export type RunFixer = (root: string, request: A11yFixRequest) => Promise<FixRunnerOutput>;

/** Runs `accessibility_runner.py --fix` in `root` and returns what it made. */
export const runFixer: RunFixer = async (root, request) => {
	const { app } = await import("electron");
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runner = path.resolve(backendPath, "runners", "accessibility_runner.py");
	const python = await requirePythonPath();
	const dir = mkdtempSync(path.join(tmpdir(), "wp-a11y-fix-"));
	const list = path.join(dir, "fixes.json");
	writeFileSync(list, JSON.stringify(request.fixIds), "utf-8");
	const args = [runner, "--project-path", root, "--fix", list, "--page-lang", request.pageLang];
	if (request.aiAlt) args.push("--ai-alt");
	try {
		return await new Promise<FixRunnerOutput>((resolve, reject) => {
			pythonRunnerEnv(backendPath)
				.then((env) => {
					const child = spawn(python, args, { cwd: backendPath, env });
					const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
					let out = "";
					child.stdout?.on("data", (chunk: Buffer) => {
						out += chunk.toString();
					});
					child.stderr?.on("data", (chunk: Buffer) => console.error("[Accessibility fix]", chunk.toString()));
					child.on("error", (err) => {
						clearTimeout(timer);
						reject(err);
					});
					child.on("close", (code) => {
						clearTimeout(timer);
						const lines = out.split("\n").map((l) => l.trim());
						const error = lines.find((l) => l.startsWith(ERROR_PREFIX));
						const result = lines.find((l) => l.startsWith(FIX_PREFIX));
						if (code !== 0 || !result) {
							reject(new Error(error?.slice(ERROR_PREFIX.length) || `accessibility fixer exited with code ${code}`));
							return;
						}
						try {
							resolve(JSON.parse(result.slice(FIX_PREFIX.length)) as FixRunnerOutput);
						} catch (err) {
							reject(err);
						}
					});
				})
				.catch(reject);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const SUMMARY = {
	en: (n: number) => `${n} accessibility fix${n === 1 ? "" : "es"} from the Accessibility page.`,
	fr: (n: number) => `${n} correction${n === 1 ? "" : "s"} d'accessibilité depuis la page Accessibilité.`,
};

export async function fixOnReviewCard(
	request: A11yFixRequest,
	openRun: (projectPath: string, subject: string) => Promise<ReviewRun> = (p, subject) =>
		openReviewRun(p, "accessibility", subject),
	fixer: RunFixer = runFixer,
): Promise<A11yFixOutcome> {
	const subject = `${request.fixIds.length} WCAG fix${request.fixIds.length === 1 ? "" : "es"}`;
	const run = await openRun(request.projectPath, subject);
	try {
		const output = await fixer(run.root, request);
		const applied = Array.isArray(output.applied) ? output.applied : [];
		const missing = Array.isArray(output.missing) ? output.missing : [];
		if (applied.length === 0) {
			await run.abandon();
			return { applied: [], missing, review: null, aiAlt: 0 };
		}
		const rules = [...new Set(applied.map((f) => f.ruleId))].sort().join(", ");
		const review = await run.finish({
			message: `fix(a11y): ${applied.length} WCAG fix${applied.length === 1 ? "" : "es"} (${rules})`.slice(0, 100),
			summary: SUMMARY[getAppLanguage() === "fr" ? "fr" : "en"](applied.length),
		});
		return { applied, missing, review: review.committed ? review : null, aiAlt: output.aiAlt ?? 0 };
	} catch (error) {
		await run.abandon().catch(() => undefined);
		throw error;
	}
}
