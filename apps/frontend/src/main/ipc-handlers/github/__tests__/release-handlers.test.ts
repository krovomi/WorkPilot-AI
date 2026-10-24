/**
 * The release notes are LLM output built from the target repo's commits:
 * they must reach gh as data (stdin), never through a shell.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";

const handlers = vi.hoisted(() => new Map<string, Function>());
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockExecSync = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Function) =>
			handlers.set(channel, handler),
	},
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const mocked = {
		...actual,
		execFileSync: mockExecFileSync,
		execSync: mockExecSync,
	};
	return { ...mocked, default: mocked };
});

vi.mock("../../../project-store", () => ({
	projectStore: {
		getProject: (id: string) =>
			id === "p1" ? { id: "p1", path: "/projects/demo" } : undefined,
	},
}));

vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => `/usr/bin/${tool}`,
}));

vi.mock("../../../platform", () => ({
	getWhichCommand: () => "which",
}));

vi.mock("../../../changelog-service", () => ({
	changelogService: {},
}));

import { buildReleaseArgs, registerCreateRelease } from "../release-handlers";

const HOSTILE_NOTES = [
	'## Notes\n\n$(id) `whoami` "; rm -rf ~; echo "',
	'" & calc.exe & "',
].join("\n");

async function createRelease(...args: unknown[]) {
	const handler = handlers.get(IPC_CHANNELS.GITHUB_CREATE_RELEASE);
	if (!handler) throw new Error("handler not registered");
	return handler({}, ...args);
}

describe("GITHUB_CREATE_RELEASE", () => {
	beforeEach(() => {
		handlers.clear();
		mockExecFileSync.mockReset();
		mockExecSync.mockReset();
		mockExecFileSync.mockReturnValue(
			"https://github.com/o/r/releases/tag/v1.2.0\n",
		);
		registerCreateRelease();
	});

	it("passes hostile notes to gh on stdin, without a shell", async () => {
		const result = await createRelease("p1", "1.2.0", HOSTILE_NOTES, {
			draft: true,
		});

		expect(result).toEqual({
			success: true,
			data: { url: "https://github.com/o/r/releases/tag/v1.2.0" },
		});
		expect(mockExecSync).not.toHaveBeenCalled();

		const releaseCall = mockExecFileSync.mock.calls.find(
			([, args]) => Array.isArray(args) && args[0] === "release",
		);
		expect(releaseCall).toBeDefined();
		const [file, args, options] = releaseCall as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(file).toBe("/usr/bin/gh");
		expect(args).toEqual([
			"release",
			"create",
			"v1.2.0",
			"--title",
			"v1.2.0",
			"--notes-file",
			"-",
			"--draft",
		]);
		expect(args.join(" ")).not.toContain("$(id)");
		expect(options.input).toBe(HOSTILE_NOTES);
		expect(options.shell).toBeUndefined();
		expect(options.cwd).toBe("/projects/demo");
	});

	it.each([
		"--repo=attacker/repo",
		"1.2.0; id",
		"$(id)",
		"",
	])("refuses the version %j before running anything", async (version) => {
		const result = await createRelease("p1", version, "notes");

		expect(result).toEqual({
			success: false,
			error: "Invalid release version",
		});
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});

	it("refuses notes that are not a string", async () => {
		const result = await createRelease("p1", "1.2.0", { toString: "x" });

		expect(result).toEqual({ success: false, error: "Invalid release notes" });
		expect(mockExecFileSync).not.toHaveBeenCalled();
	});
});

describe("buildReleaseArgs", () => {
	it("keeps the notes out of argv", () => {
		expect(buildReleaseArgs("v2.0.0", { prerelease: true })).toEqual([
			"release",
			"create",
			"v2.0.0",
			"--title",
			"v2.0.0",
			"--notes-file",
			"-",
			"--prerelease",
		]);
	});
});
