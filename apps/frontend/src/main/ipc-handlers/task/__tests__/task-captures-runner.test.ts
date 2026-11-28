/**
 * @vitest-environment node
 *
 * The runner's arguments are built in main from a closed list of actions
 * and the task's own spec name and base branch; anything else is refused
 * before a process starts. Its answer is read from its last JSON line.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "/tmp"), isPackaged: false } }));

const { buildCapturesRunnerArgs, isCapturesAction, parseCapturesRunnerOutput } = await import(
	"../task-captures-runner"
);

describe("buildCapturesRunnerArgs", () => {
	const base = { projectPath: "/home/me/project", specId: "012-orders" } as const;

	it("builds the runner's argv", () => {
		expect(
			buildCapturesRunnerArgs({ ...base, action: "approve", targetBranch: "develop" }),
		).toEqual({
			argv: [
				"approve",
				"--project-dir",
				"/home/me/project",
				"--spec-name",
				"012-orders",
				"--target-branch",
				"develop",
			],
		});
	});

	it("refuses an action, a spec name or a branch it did not expect", () => {
		expect(buildCapturesRunnerArgs({ ...base, action: "delete" as "sync" })).toEqual({
			error: "invalid-action",
		});
		expect(buildCapturesRunnerArgs({ ...base, action: "sync", specId: "../x" })).toEqual({
			error: "invalid-spec",
		});
		expect(buildCapturesRunnerArgs({ ...base, action: "sync", specId: "--project-dir" })).toEqual({
			error: "invalid-spec",
		});
		expect(buildCapturesRunnerArgs({ ...base, action: "sync", projectPath: "relative" })).toEqual({
			error: "invalid-project",
		});
		expect(
			buildCapturesRunnerArgs({ ...base, action: "sync", targetBranch: "main..evil" }),
		).toEqual({ error: "invalid-branch" });
		expect(
			buildCapturesRunnerArgs({ ...base, action: "sync", targetBranch: "--upload-pack=x" }),
		).toEqual({ error: "invalid-branch" });
	});

	it("knows the three actions only", () => {
		expect(["approve", "withdraw", "sync"].every(isCapturesAction)).toBe(true);
		expect(isCapturesAction("publish")).toBe(false);
		expect(isCapturesAction(undefined)).toBe(false);
	});
});

describe("parseCapturesRunnerOutput", () => {
	it("reads the last JSON line", () => {
		expect(
			parseCapturesRunnerOutput('log line\n{"result": {"status": "published", "hosted": 2}}\n'),
		).toEqual({ result: { status: "published", hosted: 2 } });
		expect(parseCapturesRunnerOutput('{"error": "invalid spec name"}')).toEqual({
			error: "invalid spec name",
		});
		expect(parseCapturesRunnerOutput("Traceback ...")).toBeNull();
	});
});
