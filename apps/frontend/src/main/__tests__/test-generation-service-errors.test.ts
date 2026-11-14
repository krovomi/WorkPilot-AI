/**
 * The runner's failure protocol, as the UI receives it.
 *
 * Everything the error panel can say comes through this parser, so the
 * properties that matter are: the structured line wins, its echo is dropped,
 * and a process that dies without saying anything still produces a classified
 * failure rather than "exit code 1".
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestGenerationError } from "../../shared/types/test-generation";

const { spawnMock, reviewRun, openReviewRunMock } = vi.hoisted(() => {
	const reviewRun = {
		workspace: {},
		root: "/project/.workpilot/worktrees/tasks/007-tests",
		// Like toWorkspacePath: a path outside the project has no counterpart.
		map: (target: string | undefined) =>
			target?.startsWith("/project/")
				? target.replace("/project/", "/project/.workpilot/worktrees/tasks/007-tests/")
				: target?.startsWith("/")
					? undefined
					: target,
		finish: vi.fn(),
		abandon: vi.fn(),
	};
	return { spawnMock: vi.fn(), reviewRun, openReviewRunMock: vi.fn() };
});

// A plain factory, not `importOriginal` + spread: the spread quietly leaves the
// real `spawn` in place, and the tests then shell out to a real interpreter.
vi.mock("node:child_process", () => {
	const mod = { spawn: (...args: unknown[]) => spawnMock(...args) };
	return { ...mod, default: mod };
});
vi.mock("../ipc-handlers/github/utils/runner-env", () => ({
	getRunnerEnv: async () => ({}),
}));
// Generated tests go to a review card's worktree (main/generated-review/);
// the card itself is tested there.
vi.mock("../generated-review/review-run", () => ({
	openReviewRun: (...args: unknown[]) => openReviewRunMock(...args),
	findLocalProject: () => undefined,
	ReviewUnavailableError: class ReviewUnavailableError extends Error {
		constructor(
			message: string,
			readonly details?: string,
		) {
			super(message);
		}
	},
}));
vi.mock("../generated-review/review-card", () => ({ findOpenReviewCard: () => null }));
vi.mock("../app-language", () => ({ getAppLanguage: () => "fr" }));

import { TestGenerationService } from "../test-generation-service";

// A real backend layout on disk rather than a mocked `existsSync`: the service
// probes several candidate paths, and stubbing the probe away would also stub
// away the "backend missing" branch these tests care about.
const backendDir = mkdtempSync(path.join(tmpdir(), "wp-testgen-"));
mkdirSync(path.join(backendDir, "runners"), { recursive: true });
writeFileSync(path.join(backendDir, "runners", "test_generation_runner.py"), "");

afterAll(() => {
	vi.restoreAllMocks();
});

class FakeProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill = vi.fn();
}

let proc: FakeProcess;
let service: TestGenerationService;

/** Start a generation and collect every failure it emits. */
async function run(): Promise<TestGenerationError[]> {
	const errors: TestGenerationError[] = [];
	service.on("error", (e: TestGenerationError) => errors.push(e));
	await service.generateUnitTests("/project/src/Program.cs", undefined, 80, "/project");
	return errors;
}

beforeEach(() => {
	proc = new FakeProcess();
	spawnMock.mockReset().mockReturnValue(proc);
	reviewRun.finish.mockReset().mockResolvedValue({
		taskId: "007-tests",
		specId: "007-tests",
		title: "Tests générés : Program.cs",
		branch: "workpilot/007-tests",
		baseBranch: "develop",
		files: ["tests/ProgramTests.cs"],
		committed: true,
		reused: false,
	});
	reviewRun.abandon.mockReset().mockResolvedValue(undefined);
	openReviewRunMock.mockReset().mockResolvedValue(reviewRun);
	service = new TestGenerationService();
	service.configure("python", backendDir);
});

describe("failure reporting", () => {
	it("forwards the structured failure and drops its plain echo", async () => {
		const errors = await run();

		proc.stdout.write(
			`__TG_ERROR__:${JSON.stringify({
				message: "The AI provider rejected your credentials.",
				code: "auth",
				stage: "generate",
				details: "RuntimeError: HTTP 401",
				provider: "claude",
			})}\n`,
		);
		proc.stdout.write("__TEST_GENERATION_ERROR__:The AI provider rejected\n");
		proc.emit("close", 1);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			code: "auth",
			stage: "generate",
			provider: "claude",
			details: "RuntimeError: HTTP 401",
		});
		expect(errors[0].at).toBeTypeOf("number");
	});

	it("still reports when only the plain line is available", async () => {
		const errors = await run();

		proc.stdout.write("__TEST_GENERATION_ERROR__:older backend speaking\n");
		proc.emit("close", 1);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			message: "older backend speaking",
			code: "unknown",
		});
	});

	it("does not bury a reported failure under a generic exit-code message", async () => {
		const errors = await run();

		proc.stdout.write(
			`__TG_ERROR__:${JSON.stringify({ message: "no such file", code: "file_not_found" })}\n`,
		);
		proc.stderr.write("Traceback (most recent call last): ...\n");
		proc.emit("close", 1);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("file_not_found");
	});

	it("classifies a crash the runner never got to report", async () => {
		const errors = await run();

		proc.stderr.write(
			"ModuleNotFoundError: No module named 'claude_agent_sdk'\n",
		);
		proc.emit("close", 1);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("provider_unavailable");
		expect(errors[0].exitCode).toBe(1);
		// The stderr is what makes this one actionable — it must survive.
		expect(errors[0].details).toContain("claude_agent_sdk");
	});

	it("reads a rate limit out of raw stderr", async () => {
		const errors = await run();

		proc.stderr.write("anthropic.RateLimitError: 429 Too Many Requests\n");
		proc.emit("close", 2);

		expect(errors[0].code).toBe("rate_limit");
	});

	it("separates 'ran and produced nothing' from 'crashed'", async () => {
		const errors = await run();

		proc.emit("close", 0);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("no_output");
	});

	it("stays silent when the process was cancelled", async () => {
		const errors = await run();

		// A kill signal closes with a null code — the user asked for this.
		proc.emit("close", null);

		expect(errors).toHaveLength(0);
	});

	it("says which paths it searched when the backend is missing", async () => {
		const bare = new TestGenerationService();
		const errors: TestGenerationError[] = [];
		bare.on("error", (e: TestGenerationError) => errors.push(e));
		// No backendPath configured and getBackendPath() is stubbed to fail.
		vi.spyOn(
			bare as unknown as { getBackendPath: () => string | null },
			"getBackendPath",
		).mockReturnValue(null);

		await bare.generateUnitTests("/project/src/Program.cs", undefined, 80, "/project");

		expect(errors[0].code).toBe("backend_missing");
		// Nothing was generated: the card opened for it goes away.
		expect(reviewRun.abandon).toHaveBeenCalled();
	});
});

describe("generated tests go through a review card", () => {
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

	it("writes into the card's worktree, never the project folder", async () => {
		await run();

		expect(openReviewRunMock).toHaveBeenCalledWith("/project", "test-studio", "Program.cs");
		const args = spawnMock.mock.calls[0][1] as string[];
		expect(argAfter(args, "--project-path")).toBe(reviewRun.root);
		expect(argAfter(args, "--file-path")).toBe(
			"/project/.workpilot/worktrees/tasks/007-tests/src/Program.cs",
		);
	});

	it("commits the run and hands the card to the studio", async () => {
		const completed: unknown[] = [];
		service.on("complete", (payload: unknown) => completed.push(payload));
		await run();

		proc.stdout.write(
			`__TG_EVENT__:${JSON.stringify({ type: "stage", stage: "detect", status: "done", language: "C#", framework: "xUnit" })}\n`,
		);
		proc.stdout.write("Writing tests\n");
		proc.stdout.write(
			`__TEST_GENERATION_RESULT__:${JSON.stringify({ result: { tests_generated: 3 } })}\n`,
		);
		proc.emit("close", 0);
		await flush();

		// The run's own stage lines go to the card's log; the result line does not.
		expect(reviewRun.finish).toHaveBeenCalledWith({
			message: "test: add generated unit tests for Program.cs",
			summary: "Tests unitaires de Program.cs",
			log: ["detect (done): C# · xUnit", "Writing tests"],
		});
		expect(completed).toEqual([
			expect.objectContaining({
				result: { tests_generated: 3 },
				review: expect.objectContaining({ branch: "workpilot/007-tests" }),
			}),
		]);
		expect(reviewRun.abandon).not.toHaveBeenCalled();
	});

	it("takes the card back when the run fails or is cancelled", async () => {
		await run();
		proc.emit("close", 1);
		expect(reviewRun.abandon).toHaveBeenCalledTimes(1);

		proc = new FakeProcess();
		spawnMock.mockReturnValue(proc);
		await run();
		proc.emit("close", null);
		expect(reviewRun.abandon).toHaveBeenCalledTimes(2);
		expect(reviewRun.finish).not.toHaveBeenCalled();
	});

	it("starts nothing when no review branch can be prepared", async () => {
		const { ReviewUnavailableError } = await import("../generated-review/review-run");
		openReviewRunMock.mockRejectedValueOnce(
			new ReviewUnavailableError("No review branch", "not a git repository"),
		);

		const errors = await run();

		expect(spawnMock).not.toHaveBeenCalled();
		expect(errors[0]).toMatchObject({
			code: "write_failed",
			message: "No review branch",
			details: "not a git repository",
		});
	});

	it("refuses a file outside the project", async () => {
		const errors: TestGenerationError[] = [];
		service.on("error", (e: TestGenerationError) => errors.push(e));

		await service.generateUnitTests("/elsewhere/Program.cs", undefined, 80, "/project");

		expect(spawnMock).not.toHaveBeenCalled();
		expect(errors[0].code).toBe("invalid_input");
		expect(reviewRun.abandon).toHaveBeenCalled();
	});

	it("says so when the tests could not be committed", async () => {
		reviewRun.finish.mockRejectedValueOnce(new Error("hook refused the commit"));
		const errors = await run();

		proc.stdout.write(`__TEST_GENERATION_RESULT__:${JSON.stringify({ result: {} })}\n`);
		proc.emit("close", 0);
		await flush();

		expect(errors).toEqual([
			expect.objectContaining({ code: "write_failed", details: "hook refused the commit" }),
		]);
		expect(reviewRun.abandon).toHaveBeenCalled();
	});
});
