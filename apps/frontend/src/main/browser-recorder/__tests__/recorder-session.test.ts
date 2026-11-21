/**
 * One recording at a time (#387): only an http(s) address starts the
 * runner, its steps are read through the closed lists, the main keeps them,
 * and the renderer later names them only by id.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import type { RecorderEvent } from "../../../shared/types/browser-recorder";

const state = vi.hoisted(() => ({
	packaged: false,
	sent: [] as unknown[][],
	spawned: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
}));

vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return state.packaged;
		},
		getAppPath: () => "/app/frontend",
	},
	BrowserWindow: {
		getAllWindows: () => [{ webContents: { send: (...args: unknown[]) => state.sent.push(args) } }],
	},
}));
vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[], options: Record<string, unknown>) => {
		state.spawned.push({ command, args, options });
		return new EventEmitter();
	},
}));
vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: async () => "/py/python" }));
vi.mock("../../utils/python-runner-env", () => ({
	pythonStaticRunnerEnv: (backend: string) => ({ STATIC: backend }),
}));

import {
	answerDialog,
	backendPath,
	readLines,
	readRecordUrl,
	recordedSteps,
	resetRecorderSessionForTests,
	sessionSteps,
	spawnRecorderRunner,
	startRecording,
	stopRecording,
	updateStepSelectors,
} from "../recorder-session";

function fakeChild() {
	const stdin = new PassThrough();
	const written: string[] = [];
	stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin,
		written,
	});
}

type FakeChild = ReturnType<typeof fakeChild>;

function deps(child: FakeChild) {
	const events: RecorderEvent[] = [];
	const spawnRunner = vi.fn(async () => child as never);
	return { events, spawnRunner, deps: { spawnRunner, broadcast: (e: RecorderEvent) => events.push(e) } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const button = { strategy: "role", role: "button", value: "Go" };

beforeEach(() => {
	resetRecorderSessionForTests();
	state.sent = [];
	state.spawned = [];
});
afterEach(() => vi.restoreAllMocks());

describe("readRecordUrl", () => {
	it("keeps an http(s) address only", () => {
		expect(readRecordUrl(" http://localhost:3000 ")).toBe("http://localhost:3000/");
		expect(readRecordUrl("https://shop.test/a?b=1")).toBe("https://shop.test/a?b=1");
		expect(readRecordUrl("file:///etc/passwd")).toBeNull();
		expect(readRecordUrl("javascript:alert(1)")).toBeNull();
		expect(readRecordUrl("not a url")).toBeNull();
		expect(readRecordUrl(42)).toBeNull();
		expect(readRecordUrl(`http://a.test/${"x".repeat(2100)}`)).toBeNull();
	});
});

describe("startRecording", () => {
	it("refuses no project, a bad address and a second recording", async () => {
		const child = fakeChild();
		const { deps: d, spawnRunner } = deps(child);
		expect(await startRecording("", "http://a.test", d)).toEqual({ success: false, error: "No project" });
		expect((await startRecording("/p", "file:///x", d)).success).toBe(false);
		expect(spawnRunner).not.toHaveBeenCalled();

		expect(await startRecording("/p", "http://a.test", d)).toEqual({ success: true });
		expect(spawnRunner).toHaveBeenCalledWith(["record", "--url=http://a.test/", "--project=/p"]);
		expect(await startRecording("/p", "http://a.test", d)).toEqual({
			success: false,
			error: "A recording is already running.",
		});
	});

	it("streams valid steps, keeps them, and reports the end", async () => {
		const child = fakeChild();
		const { deps: d, events } = deps(child);
		await startRecording("/p", "http://a.test", d);
		child.stdout.write(`RECORDER_STEP:${JSON.stringify({ id: "s1", kind: "navigate", url: "http://a.test/" })}\n`);
		child.stdout.write(`RECORDER_STEP:${JSON.stringify({ id: "s2", kind: "fill", selectors: [button], value: "a" })}\n`);
		child.stdout.write(`RECORDER_STEP:${JSON.stringify({ id: "s2", kind: "fill", selectors: [button], value: "ab" })}\n`);
		child.stdout.write('RECORDER_STEP:{"id":"s3","kind":"eval"}\nRECORDER_STEP:not json\nnoise\n\n');
		child.stdout.write('RECORDER_DONE:{"reason":"closed","truncated":true}\n');
		child.stderr.write("a warning");
		await tick();
		child.emit("close", 0);

		expect(events.map((e) => e.type)).toEqual(["started", "step", "step", "step", "stopped"]);
		expect(events.at(-1)).toEqual({ type: "stopped", reason: "closed", truncated: true });
		expect(recordedSteps("/p", ["s2", "s1", "s9"]).map((s) => [s.id, s.value])).toEqual([
			["s2", "ab"],
			["s1", undefined],
		]);
		expect(recordedSteps("/other", ["s1"])).toEqual([]);
		expect(stopRecording()).toEqual({ success: false });
	});

	it("caps the steps it keeps", async () => {
		const child = fakeChild();
		const { deps: d, events } = deps(child);
		await startRecording("/p", "http://a.test", d);
		for (let i = 1; i <= 301; i++) {
			child.stdout.write(`RECORDER_STEP:${JSON.stringify({ id: `s${i}`, kind: "click", selectors: [button] })}\n`);
		}
		child.stdout.write("RECORDER_DONE:not json\n");
		await tick();
		expect(events.filter((e) => e.type === "step")).toHaveLength(300);
		expect(events.at(-1)).toEqual({ type: "stopped", reason: "stopped", truncated: false });
		const ids = Array.from({ length: 301 }, (_, i) => `s${i + 1}`);
		expect(recordedSteps("/p", ids)).toHaveLength(300);
	});

	it("keeps proposed checks apart, capped, and exports one only when named", async () => {
		const child = fakeChild();
		const { deps: d, events } = deps(child);
		await startRecording("/p", "http://a.test", d);
		for (let i = 1; i <= 301; i++) {
			child.stdout.write(`RECORDER_STEP:${JSON.stringify({ id: `s${i}`, kind: "click", selectors: [button] })}\n`);
		}
		for (let i = 400; i <= 500; i++) {
			const check = { id: `s${i}`, kind: "assert_text", selectors: [button], text: "Saved", after: "s1" };
			child.stdout.write(`RECORDER_STEP:${JSON.stringify(check)}\n`);
		}
		await tick();
		const steps = events.flatMap((e) => (e.type === "step" ? [e.step] : []));
		expect(steps.filter((s) => s.after)).toHaveLength(100);
		expect(steps.filter((s) => !s.after)).toHaveLength(300);
		expect(steps.find((s) => s.id === "s400")?.after).toBe("s1");
		expect(recordedSteps("/p", ["s1", "s400", "s500"]).map((s) => s.id)).toEqual(["s1", "s400"]);
	});

	it("reports a runner error once, and a runner that died without one", async () => {
		const child = fakeChild();
		const { deps: d, events } = deps(child);
		await startRecording("/p", "http://a.test", d);
		child.stdout.write('RECORDER_ERROR:"No display"\n');
		await tick();
		child.emit("close", 1);
		expect(events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: "No display" }]);

		const second = fakeChild();
		const other = deps(second);
		await startRecording("/p", "http://a.test", other.deps);
		second.emit("error", new Error("spawn ENOENT"));
		second.emit("close", null);
		expect(other.events.filter((e) => e.type === "error")).toEqual([{ type: "error", message: "spawn ENOENT" }]);

		const third = fakeChild();
		const last = deps(third);
		await startRecording("/p", "http://a.test", last.deps);
		third.emit("close", 3);
		expect(last.events.at(-1)).toEqual({ type: "error", message: "The recorder stopped (exit code 3)." });
	});

	it("says why the runner could not start", async () => {
		const failing = {
			spawnRunner: async () => {
				throw new Error("Python is not ready");
			},
			broadcast: () => undefined,
		};
		expect(await startRecording("/p", "http://a.test", failing)).toEqual({
			success: false,
			error: "Python is not ready",
		});
		const odd = { spawnRunner: () => Promise.reject("odd"), broadcast: () => undefined };
		expect(await startRecording("/p", "http://a.test", odd)).toEqual({ success: false, error: "odd" });
	});
});

describe("stopRecording", () => {
	it("asks the running recorder to stop on its stdin", async () => {
		expect(stopRecording()).toEqual({ success: false });
		const child = fakeChild();
		await startRecording("/p", "http://a.test", deps(child).deps);
		expect(stopRecording()).toEqual({ success: true });
		await tick();
		expect(child.written).toEqual(["stop\n"]);
		child.stdin.destroy();
		expect(stopRecording()).toEqual({ success: false });
	});
});

describe("the stopped recording's steps", () => {
	it("are given out, and take new selectors, only once it has stopped", async () => {
		expect(sessionSteps("/p")).toEqual([]);
		expect(updateStepSelectors("/p", "s2", [])).toBeNull();
		const child = fakeChild();
		await startRecording("/p", "http://a.test", deps(child).deps);
		child.stdout.write(`RECORDER_STEP:${JSON.stringify({ id: "s2", kind: "click", selectors: [button] })}\n`);
		await tick();
		expect(sessionSteps("/p")).toEqual([]);
		expect(updateStepSelectors("/p", "s2", [])).toBeNull();
		child.emit("close", 0);
		expect(sessionSteps("/p").map((s) => s.id)).toEqual(["s2"]);
		expect(sessionSteps("/other")).toEqual([]);
		const css = [{ strategy: "css", value: "#go" }] as const;
		expect(updateStepSelectors("/p", "s2", css)).toEqual({ id: "s2", kind: "click", selectors: css });
		expect(recordedSteps("/p", ["s2"])[0].selectors).toEqual(css);
		expect(updateStepSelectors("/p", "s7", css)).toBeNull();
		expect(updateStepSelectors("/other", "s2", css)).toBeNull();
	});
});

describe("answerDialog", () => {
	it("passes the answer to the dialog waiting, and to no other", async () => {
		expect(answerDialog({ id: 1, accept: true })).toEqual({ success: false });
		const child = fakeChild();
		const { deps: d, events } = deps(child);
		await startRecording("/p", "http://a.test", d);
		expect(answerDialog({ id: 1, accept: true })).toEqual({ success: false });
		child.stdout.write('RECORDER_DIALOG:{"id":1,"type":"evil"}\nRECORDER_DIALOG:not json\n');
		child.stdout.write('RECORDER_DIALOG:{"id":2,"type":"prompt","message":"Name?","defaultValue":"x"}\n');
		await tick();
		expect(events.filter((e) => e.type === "dialog")).toEqual([
			{ type: "dialog", dialog: { id: 2, type: "prompt", message: "Name?", defaultValue: "x" } },
		]);
		expect(answerDialog({ id: 1, accept: true })).toEqual({ success: false });
		expect(answerDialog({ id: 2, accept: "yes" })).toEqual({ success: false });
		expect(answerDialog({ id: 2, accept: true, text: "Neo" })).toEqual({ success: true });
		// Answered once: a second answer has no dialog to go to.
		expect(answerDialog({ id: 2, accept: false })).toEqual({ success: false });
		await tick();
		expect(child.written).toEqual(['dialog {"id":2,"accept":true,"text":"Neo"}\n']);
		child.stdout.write('RECORDER_DIALOG:{"id":3,"type":"alert"}\n');
		await tick();
		child.stdin.destroy();
		expect(answerDialog({ id: 3, accept: true })).toEqual({ success: false });
	});
});

describe("defaults", () => {
	it("spawns the runner and broadcasts to every window on the record channel", async () => {
		expect(await startRecording("/p", "http://b.test")).toEqual({ success: true });
		expect(state.sent).toEqual([
			[IPC_CHANNELS.BROWSER_AGENT_RECORD_EVENT, { type: "started", url: "http://b.test/" }],
		]);
		const [run] = state.spawned;
		expect(run.command).toBe("/py/python");
		expect(run.args).toEqual([
			expect.stringMatching(/runners[\\/]browser_recorder_runner\.py$/),
			"record",
			"--url=http://b.test/",
			"--project=/p",
		]);
		expect(run.options).toEqual({ cwd: expect.stringMatching(/backend$/), env: { STATIC: run.options.cwd } });
		expect(await spawnRecorderRunner(["export"])).toBeInstanceOf(EventEmitter);
	});

	it("finds the backend next to the app, or in the resources once packaged", async () => {
		expect(await backendPath()).toMatch(/app[\\/]backend$/);
		state.packaged = true;
		Object.defineProperty(process, "resourcesPath", { value: "/res", configurable: true });
		expect(await backendPath()).toMatch(/res[\\/]backend$/);
		state.packaged = false;
	});

	it("reads lines split across chunks", () => {
		const child = fakeChild();
		const lines: string[] = [];
		readLines(child as never, (line) => lines.push(line));
		child.stdout.emit("data", Buffer.from("RECORDER_ST"));
		child.stdout.emit("data", Buffer.from("EP:{}\nnext"));
		expect(lines).toEqual(["RECORDER_STEP:{}"]);
	});
});
