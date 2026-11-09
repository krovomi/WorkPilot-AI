/**
 * Documentation drift fixes, made on a review card, never in the checkout (#354).
 *
 * The page names the fixes it wants by the ids of the last scan (a parameter
 * renamed in its doc comment, a Python docstring type, a moved file's path).
 * A review card is opened (`openReviewRun`: a worktree on the card's own
 * branch), `doc_drift_runner.py --fix` makes there the fixes it still finds,
 * and the card is committed and put in review. A run that changed nothing
 * takes its card away again.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocDriftFixOutcome, DocDriftFixRequest } from "../../shared/types/doc-drift";
import { getAppLanguage } from "../app-language";
import { openReviewRun, type ReviewRun } from "../generated-review/review-run";
import { requirePythonPath } from "../utils/ensure-python";
import { pythonRunnerEnv } from "../utils/python-runner-env";

const FIX_PREFIX = "DOC_DRIFT_FIX:";
const ERROR_PREFIX = "DOC_DRIFT_ERROR:";
const MAX_FIXES = 500;
const FIX_ID = /^(rename|retype|path):[^\0:]{1,400}:\d{1,7}:[^\0:]{1,400}:[^\0:]{1,400}$/;
const RUN_TIMEOUT_MS = 5 * 60_000;

/** The request as the renderer sent it, kept only where it is well formed (S6). */
export function readFixRequest(raw: unknown): DocDriftFixRequest | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.projectPath !== "string" || !r.projectPath) return null;
	const ids = Array.isArray(r.fixIds)
		? [...new Set(r.fixIds.filter((id): id is string => typeof id === "string" && FIX_ID.test(id)))]
		: [];
	if (ids.length === 0) return null;
	return { projectPath: r.projectPath, fixIds: ids.slice(0, MAX_FIXES) };
}

export interface FixRunnerOutput {
	readonly applied: DocDriftFixOutcome["applied"];
	readonly missing: string[];
}

export type RunFixer = (root: string, fixIds: string[]) => Promise<FixRunnerOutput>;

/** Runs `doc_drift_runner.py --fix` in `root` and returns what it made. */
export const runFixer: RunFixer = async (root, fixIds) => {
	const { app } = await import("electron");
	const backendPath = app.isPackaged
		? path.resolve(process.resourcesPath, "backend")
		: path.resolve(app.getAppPath(), "..", "backend");
	const runner = path.resolve(backendPath, "runners", "doc_drift_runner.py");
	const python = await requirePythonPath();
	const dir = mkdtempSync(path.join(tmpdir(), "wp-doc-drift-fix-"));
	const list = path.join(dir, "fixes.json");
	writeFileSync(list, JSON.stringify(fixIds), "utf-8");
	try {
		return await new Promise<FixRunnerOutput>((resolve, reject) => {
			pythonRunnerEnv(backendPath)
				.then((env) => {
					const child = spawn(python, [runner, "--project-path", root, "--fix", list], { cwd: backendPath, env });
					const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
					let out = "";
					child.stdout?.on("data", (chunk: Buffer) => {
						out += chunk.toString();
					});
					child.stderr?.on("data", (chunk: Buffer) => console.error("[DocDrift fix]", chunk.toString()));
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
							reject(new Error(error?.slice(ERROR_PREFIX.length) || `doc drift fixer exited with code ${code}`));
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
	en: (n: number) => `${n} documentation fix${n === 1 ? "" : "es"} from the drift detector.`,
	fr: (n: number) => `${n} correction${n === 1 ? "" : "s"} de documentation depuis le détecteur de dérive.`,
};

export async function fixOnReviewCard(
	request: DocDriftFixRequest,
	openRun: (projectPath: string, subject: string) => Promise<ReviewRun> = (p, subject) =>
		openReviewRun(p, "doc-drift", subject),
	fixer: RunFixer = runFixer,
): Promise<DocDriftFixOutcome> {
	const count = request.fixIds.length;
	const run = await openRun(request.projectPath, `${count} doc fix${count === 1 ? "" : "es"}`);
	try {
		const output = await fixer(run.root, request.fixIds);
		const applied = Array.isArray(output.applied) ? output.applied : [];
		const missing = Array.isArray(output.missing) ? output.missing : [];
		if (applied.length === 0) {
			await run.abandon();
			return { applied: [], missing, review: null };
		}
		const review = await run.finish({
			message: `docs: ${applied.length} drift fix${applied.length === 1 ? "" : "es"} (doc comments, paths)`.slice(0, 100),
			summary: SUMMARY[getAppLanguage() === "fr" ? "fr" : "en"](applied.length),
		});
		return { applied, missing, review: review.committed ? review : null };
	} catch (error) {
		await run.abandon().catch(() => undefined);
		throw error;
	}
}
