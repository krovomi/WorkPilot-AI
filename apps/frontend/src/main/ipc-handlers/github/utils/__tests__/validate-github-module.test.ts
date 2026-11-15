/**
 * @vitest-environment node
 *
 * What the GitHub views check before they start the app's runner: the
 * backend that holds it, the `gh` CLI (found on the machine, run without a
 * shell), its login, and the backend's Python.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	gh: "/usr/bin/gh" as string | null,
	auth: { error: null as Error | null, stdout: "", stderr: "" },
	calls: [] as Array<{ file: string; args: string[]; options: unknown }>,
}));
vi.mock("../../../../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../platform")>()),
	findExecutable: (name: string) => (name === "gh" ? state.gh : null),
}));
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	const execFile = (file: string, args: string[], ...rest: unknown[]) => {
		const callback = rest.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
		state.calls.push({ file, args, options: rest.length > 1 ? rest[0] : undefined });
		callback(state.auth.error, state.auth.stdout, state.auth.stderr);
		return {};
	};
	return { ...original, default: { ...original, execFile }, execFile };
});

import { getPythonPath, validateGitHubModule } from "../subprocess-runner";

let appRoot: string;
const backend = () => path.join(appRoot, "apps", "backend");
const install = ({ venv = true } = {}) => {
	mkdirSync(path.join(backend(), "runners", "github"), { recursive: true });
	writeFileSync(path.join(backend(), "runners", "github", "runner.py"), "");
	if (venv) {
		mkdirSync(path.dirname(getPythonPath(backend())), { recursive: true });
		writeFileSync(getPythonPath(backend()), "");
	}
};

beforeEach(() => {
	appRoot = mkdtempSync(path.join(tmpdir(), "gh-module-"));
	vi.spyOn(process, "cwd").mockReturnValue(appRoot);
	state.gh = "/usr/bin/gh";
	state.auth = { error: null, stdout: "", stderr: "" };
	state.calls = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(appRoot, { recursive: true, force: true });
});

describe("validateGitHubModule", () => {
	it("is ready when the backend has its runner and Python, and gh is logged in", async () => {
		install();

		await expect(validateGitHubModule()).resolves.toEqual({
			valid: true,
			runnerAvailable: true,
			ghCliInstalled: true,
			ghAuthenticated: true,
			pythonEnvValid: true,
			backendPath: backend(),
		});
		expect(state.calls).toEqual([{ file: "/usr/bin/gh", args: ["auth", "status"], options: undefined }]);
	});

	it("says how to install gh when the machine has none", async () => {
		install();
		state.gh = null;

		const result = await validateGitHubModule();

		expect(result).toMatchObject({ valid: false, runnerAvailable: true, ghCliInstalled: false });
		expect(result.error).toMatch(/^GitHub CLI \(gh\) is not installed\. Install it with:\n {2}\S/);
		expect(state.calls).toEqual([]);
	});

	it("says to log in when gh reports it is not", async () => {
		install();
		for (const auth of [
			{ error: new Error("exit 1"), stdout: "", stderr: "You are not logged into any GitHub hosts. Run gh auth login" },
			{ error: new Error("exit 1"), stdout: "github.com: not authenticated", stderr: "" },
		]) {
			state.auth = auth;
			const result = await validateGitHubModule();
			expect(result).toMatchObject({ valid: false, ghCliInstalled: true, ghAuthenticated: false });
			expect(result.error).toBe("GitHub CLI is not authenticated. Run:\n  gh auth login");
		}
	});

	it("counts gh as logged in when its check fails for another reason, then wants the backend's Python", async () => {
		install({ venv: false });
		state.auth = { error: new Error("network unreachable"), stdout: "", stderr: "" };

		const result = await validateGitHubModule();

		expect(result).toMatchObject({ valid: false, ghAuthenticated: true, pythonEnvValid: false });
		expect(result.error).toContain("Python virtual environment not found");
		expect(result.error).toContain(backend());
	});
});
