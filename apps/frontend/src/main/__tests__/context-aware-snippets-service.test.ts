/**
 * The line protocol of `context_aware_snippets_runner.py`, as the main process
 * reads it, and the life of one run. The Python side is pinned by
 * `tests/test_context_aware_snippets_runner.py`; this is the other half of the
 * same contract.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/constants", () => ({ MODEL_ID_MAP: {} }));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = (...args: unknown[]) => spawnMock(...args);
	return { ...actual, default: { ...actual, spawn }, spawn };
});

import {
	CONTEXT_AWARE_SNIPPETS_RUNNER,
	ContextAwareSnippetsService,
	parseRunnerLine,
} from "../context-aware-snippets-service";

describe("parseRunnerLine", () => {
	it("reads a known status code", () => {
		expect(parseRunnerLine("__STATUS__:generating")).toEqual({
			kind: "status",
			status: "generating",
		});
	});

	it("keeps an unknown status out of the UI", () => {
		expect(parseRunnerLine("__STATUS__:something else")?.kind).toBe("log");
	});

	it("decodes a delta, newlines included", () => {
		expect(parseRunnerLine(`__DELTA__:${JSON.stringify("a\nb")}`)).toEqual({
			kind: "delta",
			text: "a\nb",
		});
	});

	it("reads a result and fills what the runner left out", () => {
		expect(parseRunnerLine('__SNIPPET__:{"snippet":"const a = 1;"}')).toEqual({
			kind: "result",
			result: {
				snippet: "const a = 1;",
				language: "",
				description: "",
				context_used: [],
				adaptations: [],
				reasoning: "",
			},
		});
	});

	it("keeps only strings in the lists", () => {
		const line = `__SNIPPET__:${JSON.stringify({
			snippet: "x",
			context_used: ["AGENTS.md", "", 3],
			adaptations: "not a list",
		})}`;
		const parsed = parseRunnerLine(line);
		expect(parsed?.kind).toBe("result");
		if (parsed?.kind !== "result") return;
		expect(parsed.result.context_used).toEqual(["AGENTS.md", "3"]);
		expect(parsed.result.adaptations).toEqual([]);
	});

	it("does not trust an empty snippet", () => {
		expect(parseRunnerLine('__SNIPPET__:{"snippet":"  "}')?.kind).toBe("log");
	});

	it("reads a coded error", () => {
		expect(
			parseRunnerLine('__ERROR__:{"message":"bad key","code":"auth"}'),
		).toEqual({ kind: "error", error: { code: "auth", message: "bad key" } });
	});

	it("treats a malformed marker line as a log line", () => {
		expect(parseRunnerLine("__SNIPPET__:{not json")?.kind).toBe("log");
	});

	it("ignores blank lines and strips a Windows line ending", () => {
		expect(parseRunnerLine("   ")).toBeNull();
		expect(parseRunnerLine("__STATUS__:context\r")).toEqual({
			kind: "status",
			status: "context",
		});
	});
});

class FakeProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn();

	print(text: string) {
		this.stdout.emit("data", Buffer.from(text, "utf-8"));
	}
}

const JOB = {
	projectDir: "/repo",
	snippetType: "function" as const,
	description: "--valider un email",
};

describe("ContextAwareSnippetsService", () => {
	let backendPath: string;
	let service: ContextAwareSnippetsService;
	let events: Array<[string, unknown]>;
	let processes: FakeProcess[];
	let descriptions: string[];

	const runtime = () => ({
		pythonPath: "/venv/bin/python",
		backendPath,
		env: { SELECTED_LLM_PROVIDER: "ollama" },
	});

	beforeEach(() => {
		backendPath = mkdtempSync(path.join(tmpdir(), "snippets-backend-"));
		mkdirSync(path.join(backendPath, "runners"));
		writeFileSync(path.join(backendPath, CONTEXT_AWARE_SNIPPETS_RUNNER), "");

		processes = [];
		descriptions = [];
		spawnMock.mockReset();
		spawnMock.mockImplementation((_cmd: string, args: string[]) => {
			const file = args[args.indexOf("--description-file") + 1];
			descriptions.push(readFileSync(file, "utf-8"));
			const proc = new FakeProcess();
			processes.push(proc);
			return proc;
		});

		service = new ContextAwareSnippetsService();
		events = [];
		for (const name of ["status", "stream-chunk", "error", "complete"]) {
			service.on(name, (payload: unknown) => events.push([name, payload]));
		}
	});

	afterEach(() => {
		rmSync(backendPath, { recursive: true, force: true });
	});

	it("spawns the configured Python in the backend, with the description in a file", () => {
		service.generate({ ...JOB, language: "typescript" }, runtime());

		const [command, args, options] = spawnMock.mock.calls[0];
		expect(command).toBe("/venv/bin/python");
		expect(args).toContain("--description-file");
		expect(args).not.toContain(JOB.description);
		expect(args.slice(1, 5)).toEqual([
			"--project-dir",
			"/repo",
			"--snippet-type",
			"function",
		]);
		expect(args.slice(-2)).toEqual(["--language", "typescript"]);
		expect(descriptions).toEqual([JOB.description]);
		expect(options.cwd).toBe(backendPath);
		expect(options.env).toMatchObject({
			SELECTED_LLM_PROVIDER: "ollama",
			PYTHONUNBUFFERED: "1",
			PYTHONUTF8: "1",
		});
		expect(service.isRunning()).toBe(true);
	});

	it("reassembles lines the pipe cut in two", () => {
		service.generate(JOB, runtime());
		const proc = processes[0];

		const result = JSON.stringify({ snippet: "def f(): pass", language: "python" });
		proc.print("__STATUS__:gener");
		proc.print(`ating\n__DELTA__:${JSON.stringify("def")}\n__SNIP`);
		proc.print(`PET__:${result}\n`);
		proc.emit("close", 0);

		expect(events.map(([name]) => name)).toEqual([
			"status",
			"status",
			"stream-chunk",
			"complete",
		]);
		expect(events[1][1]).toBe("generating");
		expect(events[2][1]).toBe("def");
		expect(events[3][1]).toMatchObject({ snippet: "def f(): pass" });
		expect(service.isRunning()).toBe(false);
	});

	it("reports the runner's own coded error", () => {
		service.generate(JOB, runtime());
		processes[0].print('__ERROR__:{"message":"429","code":"rate_limit"}\n');
		processes[0].emit("close", 1);

		expect(events.at(-1)).toEqual([
			"error",
			{ code: "rate_limit", message: "429" },
		]);
	});

	it("turns a silent failure into process_failed with the stderr tail", () => {
		service.generate(JOB, runtime());
		processes[0].stderr.emit("data", Buffer.from("Traceback\nBoom\n"));
		processes[0].emit("close", 2);

		const [name, error] = events.at(-1) ?? [];
		expect(name).toBe("error");
		expect(error).toMatchObject({ code: "process_failed" });
		expect((error as { message: string }).message).toContain("Boom");
	});

	it("says nothing about a run the user cancelled", () => {
		service.generate(JOB, runtime());
		const proc = processes[0];

		expect(service.cancel()).toBe(true);
		proc.print('__SNIPPET__:{"snippet":"late"}\n');
		proc.emit("close", null);

		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(events.map(([name]) => name)).toEqual(["status"]);
		expect(service.cancel()).toBe(false);
	});

	it("ignores a run superseded by a newer one", () => {
		service.generate(JOB, runtime());
		service.generate({ ...JOB, description: "second" }, runtime());
		const [first, second] = processes;

		first.print('__SNIPPET__:{"snippet":"first"}\n');
		first.emit("close", 0);
		second.print('__SNIPPET__:{"snippet":"second"}\n');
		second.emit("close", 0);

		expect(first.kill).toHaveBeenCalledTimes(1);
		const completed = events.filter(([name]) => name === "complete");
		expect(completed).toEqual([["complete", expect.objectContaining({ snippet: "second" })]]);
	});

	it("reports a spawn error as spawn_failed", () => {
		service.generate(JOB, runtime());
		processes[0].emit("error", new Error("ENOENT"));

		expect(events.at(-1)).toEqual([
			"error",
			{ code: "spawn_failed", message: "ENOENT" },
		]);
		expect(service.isRunning()).toBe(false);
	});

	it("refuses to start without its runner", () => {
		rmSync(path.join(backendPath, CONTEXT_AWARE_SNIPPETS_RUNNER));

		service.generate(JOB, runtime());

		expect(spawnMock).not.toHaveBeenCalled();
		expect(events).toEqual([
			[
				"error",
				{
					code: "runner_missing",
					message: path.join(backendPath, CONTEXT_AWARE_SNIPPETS_RUNNER),
				},
			],
		]);
	});
});
