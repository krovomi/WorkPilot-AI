/**
 * The assistant gets the stopped recording's steps and proposed checks, with
 * the chosen provider's environment, and its answer is read through the
 * session's ids (#387).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	steps: [] as unknown[],
	suggestions: [] as unknown[],
	spawned: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
}));

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: (command: string, args: string[], options: Record<string, unknown>) => {
		state.spawned.push({ command, args, options });
		return new EventEmitter();
	},
}));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: async () => "/py/python" }));
vi.mock("../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async (backend: string) => ({ PROVIDER_ENV: backend }),
}));
vi.mock("../recorder-session", async (original) => ({
	...(await original<typeof import("../recorder-session")>()),
	backendPath: async () => "/app/backend",
	sessionSteps: () => state.steps,
	sessionSuggestions: () => state.suggestions,
}));

import { assistRecording, spawnAssistRunner } from "../recorder-assist";

function runner(lines: string[], code = 0) {
	const inputs: string[] = [];
	const spawnRunner = vi.fn(async (_args: string[]) => {
		const stdin = new PassThrough();
		stdin.on("data", (chunk: Buffer) => inputs.push(chunk.toString()));
		const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin });
		setImmediate(() => {
			child.stdout.write(lines.map((line) => `${line}\n`).join(""));
			setImmediate(() => child.emit("close", code));
		});
		return child as never;
	});
	return { inputs, spawnRunner };
}

beforeEach(() => {
	state.steps = [];
	state.suggestions = [];
	state.spawned = [];
});

describe("assistRecording", () => {
	it("needs a stopped recording", async () => {
		const { spawnRunner } = runner([]);
		expect(await assistRecording("/p", spawnRunner)).toMatchObject({ success: false });
		expect(spawnRunner).not.toHaveBeenCalled();
	});

	it("sends the steps and checks, and keeps the checks the session has", async () => {
		state.steps = [{ id: "s1", kind: "navigate", selectors: [], url: "http://a/" }];
		state.suggestions = [{ id: "s2", kind: "assert_text", selectors: [], text: "Hi", after: "s1" }];
		const answer = { name: "open a", checks: ["s9", "s2"], source: "model" };
		const { spawnRunner, inputs } = runner([`RECORDER_ASSIST:${JSON.stringify(answer)}`]);
		expect(await assistRecording("/p", spawnRunner)).toEqual({
			success: true,
			assist: { name: "open a", checks: ["s2"], source: "model" },
		});
		expect(spawnRunner).toHaveBeenCalledWith(["assist", "--project=/p"]);
		expect(JSON.parse(inputs.join(""))).toEqual({ steps: state.steps, suggestions: state.suggestions });

		const odd = runner(['RECORDER_ASSIST:{"name": 3}']);
		expect(await assistRecording("/p", odd.spawnRunner)).toEqual({
			success: false,
			error: "The assistant gave no answer.",
		});
		const failed = runner(['RECORDER_ERROR:"no provider"'], 1);
		expect(await assistRecording("/p", failed.spawnRunner)).toEqual({ success: false, error: "no provider" });
		expect(await assistRecording("/p", vi.fn(() => Promise.reject("odd")))).toEqual({ success: false, error: "odd" });
	});

	it("starts the runner with the provider's environment, without a shell", async () => {
		await spawnAssistRunner(["assist"]);
		expect(state.spawned[0].command).toBe("/py/python");
		expect(state.spawned[0].args.slice(1)).toEqual(["assist"]);
		expect(state.spawned[0].options).toMatchObject({ env: { PROVIDER_ENV: "/app/backend" } });
		expect(state.spawned[0].options.shell).toBeUndefined();
	});
});
