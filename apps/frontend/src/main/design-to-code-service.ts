import { spawn } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	DESIGN_SOURCE_TYPES,
	DESIGN_TO_CODE_STACKS,
	DESIGN_TO_CODE_STYLES,
	type DesignFileToWrite,
	type DesignToCodeProgress,
	type DesignToCodeRequest,
	type DesignToCodeResult,
	type DesignWriteOutcome,
} from "../shared/types/design-to-code";
import { getAppLanguage } from "./app-language";
import { findOpenReviewCard } from "./generated-review/review-card";
import { findLocalProject, openReviewRun, type ReviewRun } from "./generated-review/review-run";
import { projectStore } from "./project-store";
import { pythonEnvManager } from "./python-env-manager";
import {
	resolveKnownProject,
	resolveWritableUnder,
} from "./security/renderer-path";
import { getEffectiveSourcePath } from "./updater/path-resolver";
import { pythonRunnerEnv } from "./utils/python-runner-env";

/**
 * Design-to-Code service — bridges the renderer's "Import Design" panel to the
 * Python `design_to_code_runner.py`. The run reads the selected project (its
 * stack, its design tokens) but writes nothing: the runner gets `--no-write`,
 * the page shows the files, and only `writeFiles` puts the ones the person
 * accepted into the project, each path resolved inside it.
 *
 * The renderer is not trusted (security.md, S6): every field of the request
 * is checked against a closed list or a size here, and a project is named by
 * its id, never by a path.
 */

export type { DesignToCodeRequest, DesignToCodeResult };

const PHASE_PREFIX = "__DESIGN_TO_CODE_PHASE__:";
const MAX_IMAGE_DATA = 28 * 1024 * 1024; // a 20 MB image, base64-encoded
const MAX_TEXT = 4000;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;

/** What the page may not write, whatever the model proposed. */
function isProtectedPath(relative: string): boolean {
	const parts = relative.split(/[\\/]+/).filter(Boolean);
	const first = (parts[0] ?? "").toLowerCase();
	if (parts.some((p) => p.toLowerCase() === ".git")) return true;
	if (first.startsWith(".workpilot") || first.startsWith(".claude")) return true;
	if (first.startsWith(".env")) return true;
	return first === ".github" && (parts[1] ?? "").toLowerCase() === "workflows";
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value)
		? (value as T)
		: undefined;
}

function shortText(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= MAX_TEXT
		? value
		: undefined;
}

/** The project directory an id names, resolved, or `null`. */
export function projectDirFor(projectId: unknown): string | null {
	if (typeof projectId !== "string" || !projectId) return null;
	const project = projectStore.getProject(projectId);
	return project ? resolveKnownProject(project.path) : null;
}

const RESULT_PREFIX = "__DESIGN_TO_CODE_RESULT__:";
const ERROR_PREFIX = "__DESIGN_TO_CODE_ERROR__:";

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/svg+xml": ".svg",
};

export class DesignToCodeService {
	private sourcePath: string | null = null;

	configure(sourcePath?: string): void {
		if (sourcePath) this.sourcePath = sourcePath;
	}

	private getSourcePath(): string | null {
		if (this.sourcePath) return this.sourcePath;
		const resolved = getEffectiveSourcePath();
		if (
			existsSync(path.join(resolved, "runners", "design_to_code_runner.py"))
		) {
			this.sourcePath = resolved;
			return resolved;
		}
		return null;
	}

	private resolvePythonExecutable(): string {
		const managed = pythonEnvManager.getPythonPath();
		if (managed && existsSync(managed)) {
			return managed;
		}
		return "python";
	}

	/**
	 * The runner's environment: the provider the user chose and its key, the
	 * Claude sign-in only when that provider needs it, and no other credential
	 * of the app (`pythonRunnerEnv`).
	 */
	private buildEnv(sourcePath: string): Promise<Record<string, string>> {
		return pythonRunnerEnv(sourcePath);
	}

	/**
	 * Persist a data URL image to a temp file and return its path. Passing the
	 * raw base64 as an argv string overflows the Windows command line for large
	 * screenshots, so we always go through a file.
	 */
	private writeImageToTemp(dataUrl: string, workDir: string): string {
		const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
		if (!match) {
			throw new Error("Unsupported image data (expected a base64 data URL)");
		}
		const [, mime, base64] = match;
		const ext = MIME_EXTENSIONS[mime] ?? ".png";
		const imagePath = path.join(workDir, `design${ext}`);
		writeFileSync(imagePath, Buffer.from(base64, "base64"));
		return imagePath;
	}

	/**
	 * Run the pipeline. `onProgress` receives each phase as the runner
	 * reaches it, so the page shows the steps instead of one long wait.
	 */
	async run(
		request: DesignToCodeRequest,
		onProgress?: (progress: DesignToCodeProgress) => void,
	): Promise<DesignToCodeResult> {
		const sourcePath = this.getSourcePath();
		if (!sourcePath) {
			throw new Error(
				"WorkPilot AI source not found. Cannot locate design_to_code_runner.py",
			);
		}
		const req = (request ?? {}) as DesignToCodeRequest;
		const imageData =
			typeof req.imageData === "string" && req.imageData.length <= MAX_IMAGE_DATA
				? req.imageData
				: undefined;
		const figmaUrl = shortText(req.figmaUrl);
		if (!imageData && !figmaUrl) {
			throw new Error("Provide an image or a Figma URL.");
		}

		const runnerPath = path.join(
			sourcePath,
			"runners",
			"design_to_code_runner.py",
		);
		if (!existsSync(runnerPath)) {
			throw new Error("design_to_code_runner.py not found");
		}

		// The image goes through a scratch folder; the project, when one is
		// selected, is where the stack and the tokens are read from.
		const workDir = mkdtempSync(path.join(tmpdir(), "wp-design2code-"));
		const projectDir = projectDirFor(req.projectId);

		const args = [
			runnerPath,
			"--project-dir",
			projectDir ?? workDir,
			"--no-write",
		];

		if (imageData) {
			const imagePath = this.writeImageToTemp(imageData, workDir);
			args.push("--image-path", imagePath);
		}
		const framework = oneOf(req.framework, DESIGN_TO_CODE_STACKS);
		if (framework) args.push("--framework", framework);
		const style = oneOf(req.style, DESIGN_TO_CODE_STYLES);
		if (style) args.push("--style", style);
		const sourceType = oneOf(req.sourceType, DESIGN_SOURCE_TYPES);
		if (sourceType) args.push("--source-type", sourceType);
		const designSystemPath = shortText(req.designSystemPath)?.trim();
		// Relative to the project; the backend resolves it inside the project too.
		if (designSystemPath && projectDir && !path.isAbsolute(designSystemPath)) {
			args.push("--design-system-path", designSystemPath);
		}
		if (figmaUrl) args.push("--figma-url", figmaUrl);
		if (req.generateTests === false) args.push("--no-tests");
		if (req.useDesignTokens === false) args.push("--no-tokens");
		const instructions = shortText(req.customInstructions);
		if (instructions) args.push("--instructions", instructions);

		const env = await this.buildEnv(sourcePath);
		const pythonExe = this.resolvePythonExecutable();

		const running = new Promise<DesignToCodeResult>((resolve, reject) => {
			const proc = spawn(pythonExe, args, {
				cwd: sourcePath,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let parsed: DesignToCodeResult | null = null;
			let markerError: string | null = null;
			let stderrTail = "";
			let stdoutBuffer = "";

			const handleLine = (line: string) => {
				if (line.startsWith(RESULT_PREFIX)) {
					try {
						parsed = JSON.parse(line.slice(RESULT_PREFIX.length));
					} catch {
						/* ignore malformed result line */
					}
				} else if (line.startsWith(PHASE_PREFIX)) {
					try {
						onProgress?.(JSON.parse(line.slice(PHASE_PREFIX.length)));
					} catch {
						/* a malformed progress line only costs one live update */
					}
				} else if (line.startsWith(ERROR_PREFIX)) {
					markerError = line.slice(ERROR_PREFIX.length);
				}
			};

			proc.stdout?.on("data", (data: Buffer) => {
				stdoutBuffer += data.toString("utf-8");
				let idx = stdoutBuffer.indexOf("\n");
				while (idx >= 0) {
					handleLine(stdoutBuffer.slice(0, idx).trim());
					stdoutBuffer = stdoutBuffer.slice(idx + 1);
					idx = stdoutBuffer.indexOf("\n");
				}
			});

			proc.stderr?.on("data", (data: Buffer) => {
				stderrTail = (stderrTail + data.toString("utf-8")).slice(-4000);
			});

			proc.on("error", (err) => {
				reject(new Error(`Failed to start design-to-code runner: ${err.message}`));
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
				if (parsed) {
					resolve(parsed);
					return;
				}
				if (markerError) {
					reject(new Error(markerError));
					return;
				}
				reject(
					new Error(
						`Design-to-code runner exited with code ${code}. ${stderrTail.slice(-800)}`,
					),
				);
			});
		});

		let result: DesignToCodeResult;
		try {
			result = await running;
		} finally {
			// The scratch folder only held the image.
			rmSync(workDir, { recursive: true, force: true });
		}
		return projectDir ? markExisting(result, reviewRoot(projectDir)) : result;
	}

	/**
	 * Write the files the person accepted, on the branch of a review card and
	 * never in the project folder (docs/architecture/generated-review.md).
	 * Each path is resolved inside the project, then inside the card's
	 * worktree (links included); a path outside it, a protected file or an
	 * oversized content is refused, the rest written and committed. No card
	 * is opened when every file is refused.
	 */
	async writeFiles(
		projectId: unknown,
		files: unknown,
		openRun: OpenReviewRun = openReviewRun,
	): Promise<DesignWriteOutcome> {
		const projectDir = projectDirFor(projectId);
		if (!projectDir) throw new Error("Unknown project");
		if (!Array.isArray(files) || files.length > MAX_FILES) {
			throw new Error("Invalid file list");
		}
		const outcome: DesignWriteOutcome = { written: [], refused: [], review: null };
		const accepted: DesignFileToWrite[] = [];
		for (const raw of files as DesignFileToWrite[]) {
			const relative = typeof raw?.path === "string" ? raw.path : "";
			const content = raw?.content;
			if (
				!relative ||
				typeof content !== "string" ||
				Buffer.byteLength(content, "utf-8") > MAX_FILE_BYTES
			) {
				outcome.refused.push({ path: relative, reason: "invalid" });
				continue;
			}
			const reason = refusalUnder(projectDir, relative);
			if (reason) {
				outcome.refused.push({ path: relative, reason });
				continue;
			}
			accepted.push({ path: relative, content });
		}
		if (accepted.length === 0) return outcome;

		const subject = designSubject(accepted);
		const run = await openRun(projectDir, "design-import", subject);
		try {
			for (const file of accepted) {
				// The worktree is checked again: its links are not the project's.
				const reason = refusalUnder(run.root, file.path);
				const target = reason ? null : resolveWritableUnder(run.root, file.path);
				if (!target) {
					outcome.refused.push({ path: file.path, reason: reason ?? "outside" });
					continue;
				}
				mkdirSync(path.dirname(target), { recursive: true });
				const created = writeReviewedFile(target, file.content);
				if (created === null) {
					outcome.refused.push({ path: file.path, reason: "invalid" });
					continue;
				}
				outcome.written.push({ path: file.path, created });
			}
			if (outcome.written.length === 0) {
				await run.abandon();
				return outcome;
			}
			const review = await run.finish({
				message: `feat: add ${subject} from an imported design`,
				summary: STEP_SUMMARY[getAppLanguage() === "fr" ? "fr" : "en"](subject),
			});
			outcome.review = review.committed ? review : null;
			return outcome;
		} catch (error) {
			await run.abandon().catch(() => undefined);
			throw error;
		}
	}
}

type OpenReviewRun = (
	projectPath: string,
	source: "design-import",
	subject: string,
) => Promise<ReviewRun>;

const STEP_SUMMARY = {
	en: (subject: string) => `Component imported from a design: ${subject}`,
	fr: (subject: string) => `Composant importé d'un design : ${subject}`,
};

/** Why `relative` may not be written under `base`, or null when it may. */
function refusalUnder(
	base: string,
	relative: string,
): "outside" | "protected" | null {
	const target = resolveWritableUnder(base, relative);
	if (!target) return "outside";
	return isProtectedPath(path.relative(realpathOrSelf(base), target)) ? "protected" : null;
}

function realpathOrSelf(dir: string): string {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
}

/** The component's name: the first file's, without its extension. */
function designSubject(files: DesignFileToWrite[]): string {
	const first = path.basename(files[0]?.path ?? "design");
	const name = first.replace(/\.[^.]+$/, "") || first;
	return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

/**
 * Writes a reviewed file through one descriptor: created when it does not
 * exist yet, otherwise replaced only when the file that was opened is a plain
 * file (never a link, a directory or a device). No check-then-write: what is
 * checked is what is written. Returns whether it was created, or null when
 * the target is not a plain file.
 */
function writeReviewedFile(target: string, content: string): boolean | null {
	const noFollow = constants.O_NOFOLLOW ?? 0;
	let fd: number;
	let created = true;
	try {
		fd = openSync(
			target,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		created = false;
		try {
			fd = openSync(target, constants.O_WRONLY | noFollow);
		} catch {
			return null;
		}
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		ftruncateSync(fd, 0);
		writeFileSync(fd, content, "utf-8");
		return created;
	} finally {
		closeSync(fd);
	}
}

/**
 * Where the next write goes: the worktree of the Import Design card still
 * waiting for review, or the project when there is none yet (a new card
 * starts from the project's base branch).
 */
function reviewRoot(projectDir: string): string {
	const project = findLocalProject(projectDir);
	const open = project ? findOpenReviewCard(project, "design-import") : null;
	return open?.worktreePath ?? projectDir;
}

/** Flag the generated files that would replace a file of the project. */
function markExisting(
	result: DesignToCodeResult,
	projectDir: string,
): DesignToCodeResult {
	const exists = (relative: string | undefined) => {
		if (!relative) return false;
		const target = resolveWritableUnder(projectDir, relative);
		return target !== null && existsSync(target);
	};
	return {
		...result,
		generated_files: (result.generated_files ?? []).map((f) => ({
			...f,
			exists: exists(f.path),
		})),
		visual_tests: (result.visual_tests ?? []).map((t) => ({
			...t,
			exists: exists(t.path),
		})),
	};
}

export const designToCodeService = new DesignToCodeService();
