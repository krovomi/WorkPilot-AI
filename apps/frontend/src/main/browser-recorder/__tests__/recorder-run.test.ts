/**
 * The recorded test runs on its review card only, never with secrets it
 * would read from the environment; a reshoot replays the stopped recording
 * and its proposals change a step only when the person applies them (#387).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecorderEvent } from "../../../shared/types/browser-recorder";

const state = vi.hoisted(() => ({
	reviewed: undefined as unknown,
	steps: [] as unknown[],
	updated: [] as unknown[][],
}));

vi.mock("../recorder-export", () => ({ lastReviewedTest: () => state.reviewed }));
vi.mock("../recorder-session", async (original) => ({
	...(await original<typeof import("../recorder-session")>()),
	sessionSteps: () => state.steps,
	updateStepSelectors: (projectPath: string, id: string, selectors: unknown) => {
		state.updated.push([projectPath, id, selectors]);
		return id === "s9" ? null : { id, kind: "click", selectors };
	},
	broadcastRecorderEvent: vi.fn(),
	spawnRecorderRunner: vi.fn(),
}));

import { applyReshoot, defaultRunDeps, reshootRecording, resetRecorderRunForTests, runRecordedTest } from "../recorder-run";

function runner(lines: string[], code = 0) {
	const spawned: Array<{ args: string[]; input: string[] }> = [];
	const spawnRunner = vi.fn(async (args: string[]) => {
		const input: string[] = [];
		const stdin = new PassThrough();
		stdin.on("data", (chunk: Buffer) => input.push(chunk.toString()));
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin });
		spawned.push({ args, input });
		setImmediate(() => {
			child.stdout.write(lines.map((line) => `${line}\n`).join(""));
			setImmediate(() => child.emit("close", code));
		});
		return child as never;
	});
	return { spawned, spawnRunner };
}

function deps(spawnRunner: ReturnType<typeof runner>["spawnRunner"]) {
	const events: RecorderEvent[] = [];
	return { events, deps: { spawnRunner, broadcast: (event: RecorderEvent) => events.push(event) } };
}

const test = { root: "/wt/007", path: "e2e/log-in.spec.ts", format: "playwright-ts", specId: "007-x", envVars: [] };
const run = { passed: true, exitCode: 0, durationMs: 5, output: "1 passed", setup: "ready", firstRun: true, firstRuns: 1, firstPassed: 1 };

beforeEach(() => {
	resetRecorderRunForTests();
	state.reviewed = undefined;
	state.steps = [];
	state.updated = [];
});

describe("runRecordedTest", () => {
	it("needs a test proposed on a review card, without secrets", async () => {
		const { spawnRunner } = runner([]);
		expect(await runRecordedTest("/p", deps(spawnRunner).deps)).toMatchObject({ success: false });
		state.reviewed = { ...test, envVars: ["E2E_PASSWORD"] };
		expect((await runRecordedTest("/p", deps(spawnRunner).deps)).error).toContain("E2E_PASSWORD");
		expect(spawnRunner).not.toHaveBeenCalled();
	});

	it("runs it in the card's worktree and reads its result", async () => {
		state.reviewed = test;
		const { spawnRunner, spawned } = runner(["npm notice", `RECORDER_RUN:${JSON.stringify(run)}`]);
		expect(await runRecordedTest("/p", deps(spawnRunner).deps)).toEqual({ success: true, run });
		expect(spawned[0].args).toEqual([
			"run",
			"--project=/p",
			"--root=/wt/007",
			"--file=e2e/log-in.spec.ts",
			"--format=playwright-ts",
			"--spec=007-x",
		]);
	});

	it("says why a run gave nothing", async () => {
		state.reviewed = test;
		const bad = runner(['RECORDER_RUN:{"passed":"x"}']);
		expect(await runRecordedTest("/p", deps(bad.spawnRunner).deps)).toEqual({
			success: false,
			error: "The test run gave no result.",
		});
		const failed = runner(['RECORDER_ERROR:"Worktree not found"'], 1);
		expect(await runRecordedTest("/p", deps(failed.spawnRunner).deps)).toEqual({
			success: false,
			error: "Worktree not found",
		});
		const garbled = runner(["RECORDER_RUN:not json"]);
		expect((await runRecordedTest("/p", deps(garbled.spawnRunner).deps)).error).toContain("exited with code 0");
		const odd = { spawnRunner: vi.fn(() => Promise.reject("odd")), broadcast: () => undefined };
		expect(await runRecordedTest("/p", odd as never)).toEqual({ success: false, error: "odd" });
		const broken = vi.fn(async () => {
			const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
			setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
			return child as never;
		});
		expect(await runRecordedTest("/p", deps(broken).deps)).toEqual({ success: false, error: "spawn ENOENT" });
	});
});

describe("reshootRecording", () => {
	it("replays the stopped recording's steps, and applies what it proposed by id", async () => {
		const { spawnRunner } = runner([]);
		expect(await reshootRecording("/p", deps(spawnRunner).deps)).toMatchObject({ success: false });
		state.steps = [
			{ id: "s1", kind: "navigate", selectors: [], url: "http://a/" },
			{ id: "s2", kind: "click", selectors: [{ strategy: "css", value: "#old" }] },
			{ id: "s9", kind: "click", selectors: [{ strategy: "css", value: "#x" }] },
		];
		const css = [{ strategy: "css", value: "#new" }];
		const shots = {
			steps: [
				{ id: "s1", status: "ok" },
				{ id: "s2", status: "changed", selectors: css },
				{ id: "s9", status: "changed", selectors: css },
				{ id: "s7", status: "changed", selectors: css },
			],
		};
		const shoot = runner([`RECORDER_RESHOOT:${JSON.stringify(shots)}`]);
		const { deps: d, events } = deps(shoot.spawnRunner);
		const outcome = await reshootRecording("/p", d);
		expect(outcome.steps?.map((s) => s.id)).toEqual(["s1", "s2", "s9"]);
		expect(shoot.spawned[0].args).toEqual(["reshoot", "--project=/p"]);
		expect(JSON.parse(shoot.spawned[0].input.join("")).steps).toHaveLength(3);

		expect(applyReshoot("/p", ["s1", "s9", "s7"], d)).toEqual({ success: false, applied: 0 });
		expect(applyReshoot("/p", ["s2"], d)).toEqual({ success: true, applied: 1 });
		expect(events).toEqual([{ type: "step", step: { id: "s2", kind: "click", selectors: css } }]);
		// Applied once: the proposal is gone.
		expect(applyReshoot("/p", ["s2"], d)).toEqual({ success: false, applied: 0 });
		expect(applyReshoot("/other", ["s2"], d)).toEqual({ success: false, applied: 0 });

		const failed = runner(['RECORDER_ERROR:"no browser"'], 1);
		expect(await reshootRecording("/p", deps(failed.spawnRunner).deps)).toEqual({ success: false, error: "no browser" });
	});

	it("uses the session's runner and broadcast by default", () => {
		expect(defaultRunDeps.spawnRunner).toBeTypeOf("function");
		expect(defaultRunDeps.broadcast).toBeTypeOf("function");
	});
});
