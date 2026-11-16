/**
 * @vitest-environment node
 *
 * How a forge view runs its Python runner: the runner's lines as they come
 * (progress, a line split across two chunks, a last line without a newline),
 * its result or its failure, the environment it gets, and the runner stopped
 * as soon as it reports an expired login or no credit. Node plays the runner.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	active: { id: "work", name: "Work" },
	register: vi.fn(),
	unregister: vi.fn(),
}));
vi.mock("../../../../claude-profile-manager", () => ({
	getClaudeProfileManager: () => ({
		getActiveProfile: () => state.active,
		getProfile: (id: string) => ({ id, name: `Profile ${id}` }),
	}),
}));
vi.mock("../../../../claude-profile/operation-registry", () => ({
	getOperationRegistry: () => ({ registerOperation: state.register, unregisterOperation: state.unregister }),
}));

import type { AuthFailureInfo, BillingFailureInfo } from "../../../../../shared/types/terminal";
import { runPythonSubprocess } from "../subprocess-runner";

let dir: string;
const script = (body: string) => {
	const file = path.join(dir, `runner-${Math.random().toString(36).slice(2)}.cjs`);
	writeFileSync(file, body, "utf-8");
	return file;
};
const run = (body: string, options: Partial<Parameters<typeof runPythonSubprocess>[0]> = {}) =>
	runPythonSubprocess<unknown>({ pythonPath: process.execPath, args: [script(body)], cwd: dir, env: { ...process.env } as Record<string, string>, ...options });
/** A runner that waits to be stopped. */
const LINGER = "setTimeout(() => {}, 20000);";

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "subprocess-runner-"));
	state.register.mockReset();
	state.unregister.mockReset();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("runPythonSubprocess", () => {
	it("reads whole lines, even split across chunks, and reports progress", async () => {
		const onStdout = vi.fn();
		const onStderr = vi.fn();
		const onProgress = vi.fn();
		const { promise } = run(
			`process.stdout.write("[ 30%] Fetch");
			setTimeout(() => {
				process.stdout.write("ing issues\\r\\n\\n{\\"ok\\": true}\\nlast");
				process.stderr.write("warn one\\nwarn two");
			}, 100);`,
			{ onStdout, onStderr, onProgress, onComplete: (stdout) => stdout.length },
		);

		const result = await promise;

		expect(result).toMatchObject({ success: true, exitCode: 0, stderr: "warn one\nwarn two" });
		expect(result.data).toBe(result.stdout.length);
		expect(onStdout.mock.calls.map((c) => c[0])).toEqual(["[ 30%] Fetching issues", '{"ok": true}', "last"]);
		expect(onStderr.mock.calls.map((c) => c[0])).toEqual(["warn one", "warn two"]);
		expect(onProgress).toHaveBeenCalledExactlyOnceWith(30, "Fetching issues");
	});

	it("reads progress in the caller's own format", async () => {
		const onProgress = vi.fn();
		const { promise } = run('console.log("step 2 of 4: lint")', {
			onProgress,
			progressPattern: /step (\d+) of \d+: (.+)/,
		});
		await promise;
		expect(onProgress).toHaveBeenCalledWith(2, "lint");
	});

	it("fails with the runner's stderr, or its exit code when it said nothing", async () => {
		const onError = vi.fn();
		await expect(run('console.error("no token"); process.exit(2)', { onError }).promise).resolves.toMatchObject({
			success: false,
			exitCode: 2,
			error: "no token\n",
		});
		expect(onError).toHaveBeenCalledWith("no token\n");

		await expect(run("process.exit(3)").promise).resolves.toMatchObject({
			success: false,
			error: "Process failed with code 3",
		});
	});

	it("fails when the result cannot be read", async () => {
		const onError = vi.fn();
		const thrown = await run('console.log("x")', {
			onError,
			onComplete: () => {
				throw new Error("No JSON found in output");
			},
		}).promise;
		expect(thrown).toMatchObject({ success: false, exitCode: 0, error: "No JSON found in output" });
		expect(onError).toHaveBeenCalledWith("No JSON found in output");

		const odd = await run('console.log("x")', {
			onComplete: () => {
				throw "odd";
			},
		}).promise;
		expect(odd.error).toBe("Unknown error");
	});

	it("fails when the interpreter cannot start", async () => {
		const onError = vi.fn();
		const result = await runPythonSubprocess({
			pythonPath: path.join(dir, "missing", "python"),
			args: [],
			cwd: dir,
			env: {},
			onError,
		}).promise;
		expect(result).toMatchObject({ success: false, exitCode: -1 });
		expect(onError).toHaveBeenCalledWith(result.error);
	});

	it("gives the runner the caller's environment, or only the variables it needs", async () => {
		const printEnv = 'console.log(JSON.stringify(process.env))';
		const given = await run(printEnv, { env: { PATH: process.env.PATH ?? "", RUNNER_FLAG: "1" }, onComplete: (out) => JSON.parse(out) }).promise;
		expect(given.data).toMatchObject({ RUNNER_FLAG: "1" });

		vi.stubEnv("CLAUDE_TEST_SETTING", "on");
		vi.stubEnv("ANTHROPIC_TEST_URL", "http://127.0.0.1:1");
		vi.stubEnv("UNRELATED_TEST_TOKEN", "pat-test-0000");
		try {
			const fallback = await runPythonSubprocess<Record<string, string>>({
				pythonPath: process.execPath,
				args: [script(printEnv)],
				cwd: dir,
				onComplete: (out) => JSON.parse(out),
			}).promise;
			expect(fallback.data).toMatchObject({ CLAUDE_TEST_SETTING: "on", ANTHROPIC_TEST_URL: "http://127.0.0.1:1" });
			expect(fallback.data?.UNRELATED_TEST_TOKEN).toBeUndefined();
			expect(fallback.data?.RUNNER_FLAG).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("stops the runner at an expired login, once, and names the profile", async () => {
		const onAuthFailure = vi.fn();
		const { promise } = run(`console.log("API Error: 401"); console.error("API Error: 401"); ${LINGER}`, {
			onAuthFailure,
		});

		const result = await promise;

		expect(result).toMatchObject({ success: false, error: "Authentication failed. Please re-authenticate." });
		expect(onAuthFailure).toHaveBeenCalledOnce();
		expect(onAuthFailure.mock.calls[0][0]).toMatchObject({ profileId: "work", profileName: "Profile work" });
	});

	it("stops the runner at an expired login even when the callback throws", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const onAuthFailure = vi.fn((_info: AuthFailureInfo) => {
			throw new Error("window gone");
		});

		const result = await run(`console.error("OAuth token has expired"); ${LINGER}`, { onAuthFailure }).promise;

		expect(result.error).toBe("Authentication failed. Please re-authenticate.");
		expect(onAuthFailure.mock.calls[0][0]).toMatchObject({ failureType: "expired" });
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});

	it("stops the runner when the account has no credit left", async () => {
		const onBillingFailure = vi.fn((_info: BillingFailureInfo) => {
			throw new Error("window gone");
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await run(`console.log("Your credit balance is too low"); ${LINGER}`, { onBillingFailure }).promise;

		expect(result).toMatchObject({ success: false, error: "Billing or credit error. Please check your account." });
		expect(onBillingFailure).toHaveBeenCalledOnce();
		expect(onBillingFailure.mock.calls[0][0]).toMatchObject({ profileId: "work" });
		spy.mockRestore();
	});

	it("leaves an auth or credit message alone when nobody listens for it", async () => {
		const result = await run('console.log("API Error: 401"); console.log("insufficient credits")').promise;
		expect(result.success).toBe(true);
	});

	it("registers a long run with the active profile, which can stop it, and unregisters it at the end", async () => {
		const { promise } = run(LINGER, {
			operationRegistration: { operationId: "review-7", operationType: "pr-review", metadata: { pr: 7 } },
		});

		expect(state.register).toHaveBeenCalledOnce();
		const [id, type, profileId, profileName, restart, extra] = state.register.mock.calls[0];
		expect([id, type, profileId, profileName]).toEqual(["review-7", "pr-review", "work", "Work"]);
		expect(restart()).toBe(false);
		expect(extra.metadata).toMatchObject({ pr: 7, pythonPath: process.execPath, cwd: dir });

		await extra.stopFn();
		const result = await promise;

		expect(result.success).toBe(false);
		expect(state.unregister).toHaveBeenCalledWith("review-7");
	});
});
