/**
 * A recording exported as a test (#387): shown, proposed on a review card's
 * worktree, or saved outside the project; never written into the project
 * folder, and only from the steps the main kept.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	dialog: { canceled: false, filePath: "/out/login.spec.ts" } as { canceled: boolean; filePath?: string },
	dialogOptions: [] as unknown[],
	projects: [{ id: "p1", path: "/projects/app" }, { id: "r", path: "/remote", remote: true }, { id: "e", path: "" }] as unknown[],
	openReviewRun: vi.fn(),
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend", getPath: () => "/home/me/Downloads" },
	BrowserWindow: { getAllWindows: () => [] },
	dialog: {
		showSaveDialog: async (options: unknown) => {
			state.dialogOptions.push(options);
			return state.dialog;
		},
	},
}));
vi.mock("../../project-store", () => ({ projectStore: { getProjects: () => state.projects } }));
vi.mock("../../generated-review/review-run", () => ({ openReviewRun: state.openReviewRun }));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: async () => "/py" }));
vi.mock("../../utils/python-runner-env", () => ({ pythonStaticRunnerEnv: () => ({}) }));

import type { RecorderExportRequest } from "../../../shared/types/browser-recorder";
import {
	chooseFileInDialog,
	defaultExportDeps,
	exportRecording,
	generateTest,
	lastReviewedTest,
	writeTestFile,
} from "../recorder-export";
import { resetRecorderSessionForTests, startRecording } from "../recorder-session";

function child() {
	const stdin = new PassThrough();
	const input: string[] = [];
	stdin.on("data", (c: Buffer) => input.push(c.toString()));
	return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin, input });
}

/** A runner that prints `lines` then exits with `code`. */
function runnerPrinting(lines: string[], code = 0) {
	const spawned: Array<{ args: string[]; proc: ReturnType<typeof child> }> = [];
	const spawnRunner = vi.fn(async (args: string[]) => {
		const proc = child();
		spawned.push({ args, proc });
		setImmediate(() => {
			proc.stdout.write(lines.map((l) => `${l}\n`).join(""));
			setImmediate(() => proc.emit("close", code));
		});
		return proc as never;
	});
	return { spawnRunner, spawned };
}

const generated = { code: "test('x')\n", path: "e2e/log-in.spec.ts", envVars: ["E2E_PASSWORD", 3], skipped: 1 };
const ok = ["a progress line", `RECORDER_EXPORT:${JSON.stringify(generated)}`];
const request = (over: Partial<RecorderExportRequest> = {}): RecorderExportRequest => ({
	format: "playwright-ts",
	destination: "preview",
	name: "Log in",
	stepIds: ["s2", "s1"],
	...over,
});

const review = { taskId: "007", specId: "007", title: "t", branch: "workpilot/007", baseBranch: "develop", files: [], committed: true, reused: false };

function fakeRun(root = "/worktrees/007") {
	return { workspace: {} as never, root, map: (t: string | undefined) => t, finish: vi.fn(async () => review), abandon: vi.fn(async () => undefined) };
}

function deps(spawnRunner: ReturnType<typeof runnerPrinting>["spawnRunner"], over = {}) {
	return {
		spawnRunner,
		openRun: vi.fn(async () => fakeRun()),
		chooseFile: vi.fn(async () => "/out/log-in.spec.ts" as string | undefined),
		writeFile: vi.fn(),
		...over,
	};
}

async function recordTwoSteps(projectPath = "/projects/app") {
	const proc = child();
	await startRecording(projectPath, "http://a.test", { spawnRunner: async () => proc as never, broadcast: () => undefined });
	proc.stdout.write(`RECORDER_STEP:${JSON.stringify({ id: "s1", kind: "navigate", url: "http://a.test/" })}\n`);
	proc.stdout.write(
		`RECORDER_STEP:${JSON.stringify({ id: "s2", kind: "click", selectors: [{ strategy: "text", value: "Go" }] })}\n`,
	);
	await new Promise((r) => setImmediate(r));
	proc.emit("close", 0);
}

beforeEach(async () => {
	resetRecorderSessionForTests();
	await recordTwoSteps();
});

describe("exportRecording", () => {
	it("needs a kept step of this project's recording", async () => {
		const { spawnRunner } = runnerPrinting(ok);
		expect(await exportRecording("/projects/app", request({ stepIds: ["s9"] }), deps(spawnRunner))).toEqual({
			success: false,
			error: "The recording has no step to export.",
		});
		expect(await exportRecording("/projects/other", request(), deps(spawnRunner))).toMatchObject({ success: false });
		expect(spawnRunner).not.toHaveBeenCalled();
	});

	it("previews the test from the kept steps, in the order kept", async () => {
		const { spawnRunner, spawned } = runnerPrinting(ok);
		const outcome = await exportRecording("/projects/app", request(), deps(spawnRunner));
		expect(outcome).toEqual({ success: true, code: generated.code, envVars: ["E2E_PASSWORD"], skipped: 1 });
		expect(spawned[0].args).toEqual(["export", "--format=playwright-ts", "--name=Log in", "--root=/projects/app"]);
		const sent = JSON.parse(spawned[0].proc.input.join(""));
		expect(sent.steps.map((s: { id: string }) => s.id)).toEqual(["s2", "s1"]);
	});

	it("proposes the test on a review card, in its worktree", async () => {
		const { spawnRunner, spawned } = runnerPrinting(ok);
		const d = deps(spawnRunner);
		const outcome = await exportRecording("/projects/app", request({ destination: "review", name: "  " }), d);
		expect(d.openRun).toHaveBeenCalledWith("/projects/app", "recorded flow");
		expect(spawned[0].args).toContain("--root=/worktrees/007");
		expect(d.writeFile).toHaveBeenCalledWith(path.resolve("/worktrees/007", "e2e/log-in.spec.ts"), generated.code);
		const run = await d.openRun.mock.results[0].value;
		expect(run.finish).toHaveBeenCalledWith({
			message: "test(e2e): add recorded test recorded flow",
			summary: 'Browser Agent recording "recorded flow" as playwright-ts (2 steps): e2e/log-in.spec.ts',
		});
		expect(outcome).toMatchObject({ success: true, path: "e2e/log-in.spec.ts", review });
		expect(lastReviewedTest("/projects/app")).toEqual({
			root: "/worktrees/007",
			path: "e2e/log-in.spec.ts",
			format: "playwright-ts",
			specId: review.specId,
			envVars: ["E2E_PASSWORD"],
		});
		expect(lastReviewedTest("/elsewhere")).toBeUndefined();
	});

	it("writes a WebDriver test with its format's extension", async () => {
		for (const [format, file] of [
			["selenium-java", "src/test/java/e2e/LogInTest.java"],
			["selenium-python", "tests/e2e/test_log_in.py"],
			["webdriverio", "test/specs/log-in.e2e.js"],
			["selenium-csharp", "tests/E2E/LogInTests.cs"],
			["selenium-ruby", "spec/e2e/log_in_spec.rb"],
			["selenium-js", "test/e2e/log-in.e2e.cjs"],
			["webdriverio-ts", "test/specs/log-in.e2e.ts"],
		] as const) {
			const { spawnRunner, spawned } = runnerPrinting([`RECORDER_EXPORT:${JSON.stringify({ ...generated, path: file })}`]);
			const d = deps(spawnRunner);
			const outcome = await exportRecording("/projects/app", request({ format, destination: "review" }), d);
			expect(spawned[0].args).toContain(`--format=${format}`);
			expect(d.writeFile).toHaveBeenCalledWith(path.resolve("/worktrees/007", file), generated.code);
			expect(outcome).toMatchObject({ success: true, path: file });
		}
		const { spawnRunner } = runnerPrinting([`RECORDER_EXPORT:${JSON.stringify({ ...generated, path: "e2e/x.py" })}`]);
		await expect(
			exportRecording("/projects/app", request({ format: "selenium-java", destination: "review" }), deps(spawnRunner)),
		).rejects.toThrow("The generated test has no place in the project.");
	});

	it("takes the card away when the test has no place in the worktree or fails", async () => {
		for (const bad of [
			{ ...generated, path: "../../etc/x.spec.ts" },
			{ ...generated, path: "e2e/x.sh" },
		]) {
			const { spawnRunner } = runnerPrinting([`RECORDER_EXPORT:${JSON.stringify(bad)}`]);
			const run = fakeRun();
			const d = deps(spawnRunner, { openRun: async () => run });
			await expect(exportRecording("/projects/app", request({ destination: "review" }), d)).rejects.toThrow(
				"The generated test has no place in the project.",
			);
			expect(run.abandon).toHaveBeenCalled();
			expect(d.writeFile).not.toHaveBeenCalled();
		}
		const { spawnRunner } = runnerPrinting(['RECORDER_ERROR:"boom"'], 1);
		const run = fakeRun();
		run.abandon.mockRejectedValueOnce(new Error("busy"));
		await expect(
			exportRecording("/projects/app", request({ destination: "review" }), deps(spawnRunner, { openRun: async () => run })),
		).rejects.toThrow("boom");
	});

	it("saves to the file the person chose, never inside a project", async () => {
		const { spawnRunner } = runnerPrinting(ok);
		const d = deps(spawnRunner);
		expect(await exportRecording("/projects/app", request({ destination: "file" }), d)).toMatchObject({
			success: true,
			path: path.resolve("/out/log-in.spec.ts"),
		});
		expect(d.chooseFile).toHaveBeenCalledWith("log-in.spec.ts");
		expect(d.writeFile).toHaveBeenCalledWith(path.resolve("/out/log-in.spec.ts"), generated.code);

		const inside = deps(runnerPrinting(ok).spawnRunner, { chooseFile: async () => "/projects/app/e2e/x.spec.ts" });
		expect(await exportRecording("/projects/app", request({ destination: "file" }), inside)).toMatchObject({
			success: false,
		});
		expect(inside.writeFile).not.toHaveBeenCalled();

		const remote = deps(runnerPrinting(ok).spawnRunner, { chooseFile: async () => "/remote/x.spec.ts" });
		expect((await exportRecording("/projects/app", request({ destination: "file" }), remote)).success).toBe(true);

		const closed = deps(runnerPrinting(ok).spawnRunner, { chooseFile: async () => undefined });
		expect(await exportRecording("/projects/app", request({ destination: "file" }), closed)).toMatchObject({
			cancelled: true,
		});
		expect(closed.writeFile).not.toHaveBeenCalled();
	});
});

describe("generateTest", () => {
	const steps = [{ id: "s1", kind: "navigate" as const, selectors: [], url: "http://a.test/" }];

	it("rejects with the runner's error, or its exit code", async () => {
		await expect(generateTest(runnerPrinting(['RECORDER_ERROR:"bad"'], 1).spawnRunner, steps, request(), "/r")).rejects.toThrow("bad");
		await expect(generateTest(runnerPrinting(["RECORDER_EXPORT:{oops"]).spawnRunner, steps, request(), "/r")).rejects.toThrow(
			"The test exporter exited with code 0",
		);
		await expect(
			generateTest(runnerPrinting(['RECORDER_EXPORT:{"code":1,"path":"x"}']).spawnRunner, steps, request(), "/r"),
		).rejects.toThrow("exited with code 0");
		await expect(
			generateTest(runnerPrinting(['RECORDER_EXPORT:{"code":"c"}']).spawnRunner, steps, request(), "/r"),
		).rejects.toThrow("exited with code 0");
		await expect(generateTest(runnerPrinting([]).spawnRunner, steps, request(), "/r")).rejects.toThrow("exited with code 0");
	});

	it("reads defaults for missing lists and counts, and fails when the process does", async () => {
		const bare = runnerPrinting(['RECORDER_EXPORT:{"code":"c","path":"p"}']).spawnRunner;
		expect(await generateTest(bare, steps, request(), "/r")).toEqual({ code: "c", path: "p", envVars: [], skipped: 0 });
		const failing = vi.fn(async () => {
			const proc = child();
			setImmediate(() => proc.emit("error", new Error("ENOENT")));
			return proc as never;
		});
		await expect(generateTest(failing, steps, request(), "/r")).rejects.toThrow("ENOENT");
	});
});

describe("defaults", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "recorder-export-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("asks the save dialog in Downloads, and hears a cancel", async () => {
		state.dialog = { canceled: false, filePath: "/out/a.py" };
		expect(await chooseFileInDialog("a.py")).toBe("/out/a.py");
		expect(state.dialogOptions[0]).toEqual({
			defaultPath: path.join("/home/me/Downloads", "a.py"),
			filters: [{ name: "py", extensions: ["py"] }],
		});
		state.dialog = { canceled: true };
		expect(await chooseFileInDialog("a.py")).toBeUndefined();
		expect(defaultExportDeps.chooseFile).toBe(chooseFileInDialog);
	});

	it("writes the file, its folder included", () => {
		const file = path.join(dir, "nested", "t.cy.js");
		defaultExportDeps.writeFile(file, "cy.visit('x');\n");
		expect(readFileSync(file, "utf-8")).toBe("cy.visit('x');\n");
		expect(defaultExportDeps.writeFile).toBe(writeTestFile);
	});

	it("opens the review card as the recorder's page", async () => {
		state.openReviewRun.mockResolvedValue(fakeRun());
		await defaultExportDeps.openRun("/projects/app", "Log in");
		expect(state.openReviewRun).toHaveBeenCalledWith("/projects/app", "browser-recorder", "Log in");
	});
});
