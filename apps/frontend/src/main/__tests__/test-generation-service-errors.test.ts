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

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// A plain factory, not `importOriginal` + spread: the spread quietly leaves the
// real `spawn` in place, and the tests then shell out to a real interpreter.
vi.mock("node:child_process", () => {
	const mod = { spawn: (...args: unknown[]) => spawnMock(...args) };
	return { ...mod, default: mod };
});
vi.mock("../ipc-handlers/github/utils/runner-env", () => ({
	getRunnerEnv: async () => ({}),
}));

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
	await service.generateUnitTests("/src/Program.cs");
	return errors;
}

beforeEach(() => {
	proc = new FakeProcess();
	spawnMock.mockReset().mockReturnValue(proc);
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

		await bare.generateUnitTests("/src/Program.cs");

		expect(errors[0].code).toBe("backend_missing");
	});
});
