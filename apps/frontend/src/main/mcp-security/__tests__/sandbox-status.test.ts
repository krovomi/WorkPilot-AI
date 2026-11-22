/**
 * Whether this machine starts a confined MCP server (#369, lot 6), as the
 * backend's runner answers: read field by field, kept once known, asked
 * again when unknown or on demand; the runner started by its path, without
 * a shell, with the runner environment.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
	spawn: vi.fn(),
	readyPythonPath: vi.fn(async (): Promise<string | null> => "/py/bin/python"),
	pythonRunnerEnv: vi.fn(async () => ({ PATH: "/bin" })),
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
}));

vi.mock("node:child_process", () => ({ spawn: deps.spawn }));
vi.mock("electron", () => ({ app: deps.app }));
vi.mock("../../app-logger", () => ({ appLog: { debug: vi.fn() } }));
vi.mock("../../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, ["-I"]],
}));
vi.mock("../../utils/ensure-python", () => ({ readyPythonPath: deps.readyPythonPath }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: deps.pythonRunnerEnv }));

import {
	mcpSandboxStatus,
	parseSandboxProbe,
	parseSandboxRequest,
	runSandboxRunner,
	SANDBOX_RUNNER,
	SandboxStatusCache,
} from "../sandbox-status";

const MISSING = {
	available: false,
	kind: "missing",
	backend: "bubblewrap",
	reason: "bubblewrap (bwrap) is not installed",
};

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn();
}

function child(): FakeChild {
	const fake = new FakeChild();
	deps.spawn.mockReturnValueOnce(fake);
	return fake;
}

beforeEach(() => {
	deps.spawn.mockReset();
	deps.readyPythonPath.mockResolvedValue("/py/bin/python");
});

describe("parseSandboxProbe", () => {
	it("reads the runner's last JSON line", () => {
		const stdout = `warning: something\n${JSON.stringify(MISSING)}\n`;
		expect(parseSandboxProbe({ stdout })).toEqual(MISSING);
		expect(
			parseSandboxProbe({
				stdout: JSON.stringify({ available: true, kind: "available", backend: "seatbelt", reason: null }),
			}),
		).toEqual({ available: true, kind: "available", backend: "seatbelt", reason: null });
	});

	it("caps long texts", () => {
		const status = parseSandboxProbe({
			stdout: JSON.stringify({ ...MISSING, backend: "b".repeat(100), reason: "r".repeat(900) }),
		});
		expect(status.backend).toHaveLength(64);
		expect(status.reason).toHaveLength(500);
	});

	it.each([
		["", "gave no answer"],
		["not json", "gave no answer"],
		[JSON.stringify({ ...MISSING, kind: "great" }), "gave no answer"],
		[JSON.stringify({ ...MISSING, available: "no" }), "gave no answer"],
		[JSON.stringify({ ...MISSING, extra: 1, reason: 3 }), "gave no answer"],
		// "available" with a refusal's kind, or the reverse, is not an answer.
		[JSON.stringify({ ...MISSING, available: true }), "gave no answer"],
		[JSON.stringify({ available: false, kind: "available", backend: null, reason: null }), "gave no answer"],
	])("is unknown for %j", (stdout, reason) => {
		const status = parseSandboxProbe({ stdout });
		expect(status).toMatchObject({ available: false, kind: "unknown", backend: null });
		expect(status.reason).toContain(reason);
	});

	it("is unknown, with the reason, when the runner could not run", () => {
		expect(parseSandboxProbe({ error: "Python environment not ready" })).toEqual({
			available: false,
			kind: "unknown",
			backend: null,
			reason: "Python environment not ready",
		});
	});
});

describe("parseSandboxRequest", () => {
	it.each([
		[undefined, { refresh: false }],
		[null, { refresh: false }],
		[{}, { refresh: false }],
		[{ refresh: false }, { refresh: false }],
		[{ refresh: true }, { refresh: true }],
		["x", null],
		[[], null],
		[{ refresh: 1 }, null],
		[{ path: "/usr/bin/bwrap" }, null],
	])("%j", (request, expected) => {
		expect(parseSandboxRequest(request)).toEqual(expected);
	});
});

describe("SandboxStatusCache", () => {
	it("asks once while the answer is known, and again on demand", async () => {
		const run = vi.fn(async () => ({ stdout: JSON.stringify(MISSING) }));
		const cache = new SandboxStatusCache(run);
		expect(await cache.get()).toEqual(MISSING);
		expect(await cache.get()).toEqual(MISSING);
		expect(run).toHaveBeenCalledTimes(1);
		await cache.get(true);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does not keep an unknown answer, nor a runner that throws", async () => {
		const run = vi
			.fn()
			.mockRejectedValueOnce(new Error("spawn EACCES"))
			.mockRejectedValueOnce("odd")
			.mockResolvedValueOnce({ stdout: JSON.stringify(MISSING) });
		const cache = new SandboxStatusCache(run);
		expect(await cache.get()).toMatchObject({ kind: "unknown", reason: "spawn EACCES" });
		expect(await cache.get()).toMatchObject({ kind: "unknown", reason: "The sandbox check failed" });
		expect(await cache.get()).toEqual(MISSING);
		expect(await cache.get()).toEqual(MISSING);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("keeps a newer answer when an older unknown one settles after it", async () => {
		let release!: (value: { error: string }) => void;
		const run = vi
			.fn()
			.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
			.mockResolvedValue({ stdout: JSON.stringify(MISSING) });
		const cache = new SandboxStatusCache(run);
		const first = cache.get();
		const second = cache.get(true);
		release({ error: "late" });
		await first;
		expect(await second).toEqual(MISSING);
		expect(await cache.get()).toEqual(MISSING);
		expect(run).toHaveBeenCalledTimes(2);
	});
});

describe("runSandboxRunner", () => {
	const backend = path.resolve("/app/frontend", "..", "backend");

	it("starts the backend's runner by its path, without a shell", async () => {
		const fake = child();
		const answer = runSandboxRunner();
		await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
		expect(deps.spawn).toHaveBeenCalledWith(
			"/py/bin/python",
			["-I", path.join(backend, "runners", SANDBOX_RUNNER)],
			{ cwd: backend, env: { PATH: "/bin" } },
		);
		expect(deps.pythonRunnerEnv).toHaveBeenCalledWith(backend);
		fake.stderr.emit("data", Buffer.from("a warning\n"));
		fake.stdout.emit("data", Buffer.from('{"available": tr'));
		fake.stdout.emit("data", Buffer.from('ue, "kind": "available", "backend": "x", "reason": null}\n'));
		fake.emit("close", 0);
		expect(await answer).toEqual({
			stdout: '{"available": true, "kind": "available", "backend": "x", "reason": null}\n',
		});
	});

	it("finds the runner in the packaged app's resources", async () => {
		deps.app.isPackaged = true;
		const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
		Object.defineProperty(process, "resourcesPath", { value: "/opt/app/resources", configurable: true });
		try {
			const fake = child();
			const answer = runSandboxRunner();
			await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
			const packaged = path.resolve("/opt/app/resources", "backend");
			expect(deps.spawn.mock.calls[0]?.[1]).toEqual([
				"-I",
				path.join(packaged, "runners", SANDBOX_RUNNER),
			]);
			fake.emit("close", 0);
			await answer;
		} finally {
			deps.app.isPackaged = false;
			if (resources) Object.defineProperty(process, "resourcesPath", resources);
			else Reflect.deleteProperty(process, "resourcesPath");
		}
	});

	it("says why it could not ask", async () => {
		deps.readyPythonPath.mockResolvedValueOnce(null);
		expect(await runSandboxRunner()).toEqual({ error: "Python environment not ready" });

		deps.spawn.mockImplementationOnce(() => {
			throw new Error("ENOENT");
		});
		expect(await runSandboxRunner()).toEqual({ error: "ENOENT" });
		deps.spawn.mockImplementationOnce(() => {
			throw "odd";
		});
		expect(await runSandboxRunner()).toEqual({ error: "Failed to start" });

		const fake = child();
		const failed = runSandboxRunner();
		await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(3));
		fake.emit("error", new Error("EACCES"));
		expect(await failed).toEqual({ error: "EACCES" });
	});

	it("stops a runner that does not answer", async () => {
		vi.useFakeTimers();
		try {
			const fake = child();
			const answer = runSandboxRunner();
			await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalled());
			await vi.advanceTimersByTimeAsync(60_000);
			expect(await answer).toEqual({ error: "The sandbox check timed out" });
			expect(fake.kill).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("mcpSandboxStatus", () => {
	it("asks the runner once for the whole app", async () => {
		const fake = child();
		const first = mcpSandboxStatus();
		await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(1));
		fake.stdout.emit("data", Buffer.from(JSON.stringify(MISSING)));
		fake.emit("close", 0);
		expect(await first).toEqual(MISSING);
		expect(await mcpSandboxStatus()).toEqual(MISSING);
		expect(deps.spawn).toHaveBeenCalledTimes(1);
	});
});
