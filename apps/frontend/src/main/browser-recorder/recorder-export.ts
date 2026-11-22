/**
 * A recording exported as a test: shown, proposed on a review card, or saved
 * where the person chooses (#387).
 *
 * The runner writes the code (`browser_recorder_runner.py export`), from the
 * steps the main kept for the session (`recordedSteps`): the renderer only
 * names which ones, by id. The code then goes:
 *
 * - `preview`: nowhere, it is shown;
 * - `review`: into the worktree of a review card, on its own branch, and the
 *   card waits in human review (`docs/architecture/generated-review.md`):
 *   never into the project folder;
 * - `file`: to the path the person picked in the native save dialog, which
 *   is refused inside a project of this computer, since that is the review
 *   card's job.
 *
 * The values typed while recording come with the test as its data file
 * (`browser-recorder-data.ts`): on a review card, at the path the exporter
 * gave, inside the worktree and ending in `.json`; in a chosen folder, next
 * to the test under its own name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dialog } from "electron";
import { readTestData, type TestDataValue, type TestFixture } from "../../shared/types/browser-recorder-data";
import type {
	RecordedStep,
	RecorderExportOutcome,
	RecorderExportRequest,
	TestFormat,
} from "../../shared/types/browser-recorder";
import { openReviewRun, type ReviewRun } from "../generated-review/review-run";
import { projectStore } from "../project-store";
import { isPathWithinBase } from "../worktree-paths";
import { decodeRunnerError } from "../utils/runner-error";
import {
	ERROR_PREFIX,
	EXPORT_PREFIX,
	readLines,
	recordedSteps,
	type SpawnRunner,
	spawnRecorderRunner,
} from "./recorder-session";

export interface GeneratedTestFile {
	readonly code: string;
	readonly path: string;
	readonly envVars: readonly string[];
	readonly skipped: number;
	readonly dataValues: readonly TestDataValue[];
	readonly fixture?: TestFixture;
}

export interface ExportDeps {
	readonly spawnRunner: SpawnRunner;
	readonly openRun: (projectPath: string, subject: string) => Promise<ReviewRun>;
	readonly chooseFile: (defaultName: string) => Promise<string | undefined>;
	readonly writeFile: (file: string, code: string) => void;
}

/** The last test proposed on a review card, by project: what `recorder-run.ts` runs. */
export interface ReviewedTest {
	readonly root: string;
	readonly path: string;
	readonly format: TestFormat;
	readonly specId: string;
	readonly envVars: readonly string[];
}

const reviewed = new Map<string, ReviewedTest>();

export function lastReviewedTest(projectPath: string): ReviewedTest | undefined {
	return reviewed.get(projectPath);
}

const EXTENSIONS: Record<TestFormat, string> = {
	"playwright-ts": "ts",
	"playwright-python": "py",
	cypress: "js",
	"selenium-python": "py",
	"selenium-java": "java",
	"selenium-csharp": "cs",
	"selenium-ruby": "rb",
	"selenium-js": "cjs",
	webdriverio: "js",
	"webdriverio-ts": "ts",
};

export async function chooseFileInDialog(defaultName: string): Promise<string | undefined> {
	const { app } = await import("electron");
	const extension = path.extname(defaultName).slice(1);
	const result = await dialog.showSaveDialog({
		defaultPath: path.join(app.getPath("downloads"), defaultName),
		filters: [{ name: extension, extensions: [extension] }],
	});
	return result.canceled ? undefined : result.filePath;
}

export function writeTestFile(file: string, code: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, code, "utf-8");
}

export const defaultExportDeps: ExportDeps = {
	spawnRunner: spawnRecorderRunner,
	openRun: (projectPath, subject) => openReviewRun(projectPath, "browser-recorder", subject),
	chooseFile: chooseFileInDialog,
	writeFile: writeTestFile,
};

/** Runs the exporter on `steps` and reads its single result line. */
export async function generateTest(
	spawnRunner: SpawnRunner,
	steps: readonly RecordedStep[],
	request: RecorderExportRequest,
	root: string,
): Promise<GeneratedTestFile> {
	const child = await spawnRunner([
		"export",
		`--format=${request.format}`,
		`--name=${request.name}`,
		`--root=${root}`,
	]);
	return new Promise((resolve, reject) => {
		let result: string | null = null;
		let error: string | null = null;
		readLines(child, (line) => {
			if (line.startsWith(EXPORT_PREFIX)) result = line.slice(EXPORT_PREFIX.length);
			else if (line.startsWith(ERROR_PREFIX)) error = decodeRunnerError(line.slice(ERROR_PREFIX.length));
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const parsed = (() => {
				try {
					return JSON.parse(result ?? "null") as Record<string, unknown> | null;
				} catch {
					return null;
				}
			})();
			if (code !== 0 || !parsed || typeof parsed.code !== "string" || typeof parsed.path !== "string") {
				reject(new Error(error ?? `The test exporter exited with code ${code}`));
				return;
			}
			resolve({
				code: parsed.code,
				path: parsed.path,
				envVars: Array.isArray(parsed.envVars)
					? parsed.envVars.filter((v): v is string => typeof v === "string")
					: [],
				skipped: typeof parsed.skipped === "number" ? parsed.skipped : 0,
				...readTestData(parsed),
			});
		});
		child.stdin?.end(JSON.stringify({ steps }));
	});
}

/** Whether `file` is inside a project of this computer. */
function insideLocalProject(file: string): boolean {
	return projectStore
		.getProjects()
		.some((project) => !project.remote && Boolean(project.path) && isPathWithinBase(file, project.path));
}

export async function exportRecording(
	projectPath: string,
	request: RecorderExportRequest,
	deps: ExportDeps = defaultExportDeps,
): Promise<RecorderExportOutcome> {
	const steps = recordedSteps(projectPath, request.stepIds);
	if (!steps.length) return { success: false, error: "The recording has no step to export." };
	const name = request.name.trim() || "recorded flow";

	if (request.destination === "review") {
		const run = await deps.openRun(projectPath, name);
		try {
			const test = await generateTest(deps.spawnRunner, steps, request, run.root);
			const target = path.resolve(run.root, test.path);
			if (!isPathWithinBase(target, run.root) || !target.endsWith(`.${EXTENSIONS[request.format]}`)) {
				throw new Error("The generated test has no place in the project.");
			}
			// A data file ends in `.json` (`readTestData`), the test never does: they never collide.
			const fixture = test.fixture && { file: path.resolve(run.root, test.fixture.path), code: test.fixture.code };
			if (fixture && !isPathWithinBase(fixture.file, run.root)) {
				throw new Error("The test's data file has no place in the project.");
			}
			deps.writeFile(target, test.code);
			if (fixture) deps.writeFile(fixture.file, fixture.code);
			const files = test.fixture ? `${test.path}, ${test.fixture.path}` : test.path;
			const review = await run.finish({
				message: `test(e2e): add recorded test ${name}`,
				summary: `Browser Agent recording "${name}" as ${request.format} (${steps.length} steps): ${files}`,
			});
			reviewed.set(projectPath, {
				root: run.root,
				path: test.path,
				format: request.format,
				specId: review.specId,
				envVars: test.envVars,
			});
			return { ...outcomeOf(test), path: test.path, review };
		} catch (error) {
			await run.abandon().catch(() => undefined);
			throw error;
		}
	}

	const test = await generateTest(deps.spawnRunner, steps, request, projectPath);
	const outcome = outcomeOf(test);
	if (request.destination === "preview") return outcome;

	const chosen = await deps.chooseFile(path.basename(test.path));
	if (!chosen) return { ...outcome, cancelled: true };
	const file = path.resolve(chosen);
	if (insideLocalProject(file)) {
		return {
			success: false,
			error: "A file inside a project is proposed on a review card instead: choose a folder outside the project.",
		};
	}
	const fixture = test.fixture && {
		path: path.join(path.dirname(file), path.basename(test.fixture.path)),
		code: test.fixture.code,
	};
	if (fixture?.path === file) {
		return { success: false, error: "The test and its data file would have the same name: choose another name." };
	}
	deps.writeFile(file, test.code);
	if (!fixture) return { ...outcome, path: file };
	deps.writeFile(fixture.path, fixture.code);
	return { ...outcome, path: file, fixture };
}

/** What the renderer is shown of a generated test (its data file, relative to the project). */
function outcomeOf(test: GeneratedTestFile): RecorderExportOutcome {
	return {
		success: true,
		code: test.code,
		envVars: test.envVars,
		skipped: test.skipped,
		...(test.dataValues.length ? { dataValues: test.dataValues } : {}),
		...(test.fixture ? { fixture: test.fixture } : {}),
	};
}
