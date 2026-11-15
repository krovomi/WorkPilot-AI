/**
 * @vitest-environment node
 *
 * Reading, writing and discarding files of a worktree over IPC, on a real
 * git repository. The renderer names the file: a path that climbs out of
 * the worktree is refused, a file name full of shell characters is only
 * ever an argument, and discarding restores the base branch's version (or
 * deletes an untracked file) and records it in the discard list.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../../shared/constants";
import { registerWorktreeFileHandlers } from "../worktree-file-handlers";

type Result = { success: boolean; error?: string; data?: unknown };
const invoke = (channel: string, ...args: unknown[]): Promise<Result> =>
	(
		ipcMain as unknown as {
			invokeHandler: (c: string, e: unknown, ...a: unknown[]) => Promise<Result>;
		}
	).invokeHandler(channel, {}, ...args);

registerWorktreeFileHandlers();

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

let base = "";
let wt = "";
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "wt-files-"));
	wt = path.join(base, "worktree");
	mkdirSync(wt);
	git(wt, "init", "-q", "-b", "main");
	// Windows runners check out CRLF otherwise, and the tests compare bytes.
	git(wt, "config", "core.autocrlf", "false");
	git(wt, "config", "user.email", "test@example.invalid");
	git(wt, "config", "user.name", "Test");
	git(wt, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(wt, "tracked.txt"), "original\n", "utf-8");
	git(wt, "add", "tracked.txt");
	git(wt, "commit", "-q", "-m", "init");
	writeFileSync(path.join(base, "outside.txt"), "secret\n", "utf-8");
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("TASK_WORKTREE_READ_FILE", () => {
	it("reads a file of the worktree and refuses one outside it", async () => {
		expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_READ_FILE, wt, "tracked.txt")).toEqual({
			success: true,
			data: "original\n",
		});
		for (const bad of ["../outside.txt", path.join(base, "outside.txt"), 42]) {
			expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_READ_FILE, wt, bad)).toEqual({
				success: false,
				error: "Path traversal not allowed",
			});
		}
		// A folder is not a file.
		mkdirSync(path.join(wt, "dir"));
		expect((await invoke(IPC_CHANNELS.TASK_WORKTREE_READ_FILE, wt, "dir")).success).toBe(false);
	});

	it("passes on a read error", async () => {
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_READ_FILE, wt, "missing.txt");
		expect(result.success).toBe(false);
	});
});

describe("TASK_WORKTREE_WRITE_FILE", () => {
	it("writes a file, creating its folders, and refuses a path outside the worktree", async () => {
		expect(
			await invoke(IPC_CHANNELS.TASK_WORKTREE_WRITE_FILE, wt, "deep/new/file.ts", "export {};\n"),
		).toEqual({ success: true, data: { written: true } });
		expect(readFileSync(path.join(wt, "deep", "new", "file.ts"), "utf-8")).toBe("export {};\n");

		for (const bad of ["../outside.txt", "", ".", path.join(base, "x.txt")]) {
			expect(await invoke(IPC_CHANNELS.TASK_WORKTREE_WRITE_FILE, wt, bad, "pwned")).toEqual({
				success: false,
				error: "Path traversal not allowed",
			});
		}
		expect(readFileSync(path.join(base, "outside.txt"), "utf-8")).toBe("secret\n");
	});

	it("passes on a write error", async () => {
		mkdirSync(path.join(wt, "taken"));
		const result = await invoke(IPC_CHANNELS.TASK_WORKTREE_WRITE_FILE, wt, "taken", "x");
		expect(result.success).toBe(false);
	});
});

describe("TASK_WORKTREE_DELETE_FILES", () => {
	const discard = (paths: unknown) => invoke(IPC_CHANNELS.TASK_WORKTREE_DELETE_FILES, wt, paths);
	const discardList = () => readFileSync(path.join(wt, ".workpilot-discard-list"), "utf-8");

	it("wants a list", async () => {
		expect(await discard("tracked.txt")).toEqual({
			success: false,
			error: "Expected a list of paths",
		});
	});

	it("restores a tracked file, deletes an untracked one, refuses one outside and lists them all", async () => {
		writeFileSync(path.join(wt, "tracked.txt"), "changed by the agent\n", "utf-8");
		git(wt, "add", "tracked.txt");
		// A name that would run a command in a shell is just a file here.
		const odd = 'a" & echo pwned & ".txt';
		const oddPath = path.join(wt, odd);
		let oddSupported = true;
		try {
			writeFileSync(oddPath, "x", "utf-8");
		} catch {
			oddSupported = false; // Windows refuses `"` in a name
		}
		writeFileSync(path.join(wt, "untracked.txt"), "new\n", "utf-8");
		writeFileSync(path.join(wt, ".workpilot-discard-list"), "# kept\nearlier.txt\n", "utf-8");

		const paths = ["tracked.txt", "untracked.txt", "../outside.txt", ...(oddSupported ? [odd] : [])];
		const result = await discard(paths);

		expect(result).toEqual({
			success: true,
			data: {
				deleted: ["tracked.txt", "untracked.txt", ...(oddSupported ? [odd] : [])],
				failed: ["../outside.txt"],
			},
		});
		expect(readFileSync(path.join(wt, "tracked.txt"), "utf-8")).toBe("original\n");
		expect(git(wt, "diff", "--cached", "--name-only")).toBe("");
		expect(existsSync(path.join(wt, "untracked.txt"))).toBe(false);
		expect(existsSync(oddPath)).toBe(false);
		expect(existsSync(path.join(base, "outside.txt"))).toBe(true);
		expect(discardList()).toBe(
			["earlier.txt", "tracked.txt", "untracked.txt", ...(oddSupported ? [odd] : [])].join("\n") +
				"\n",
		);
	});

	it("records an unchanged file once, and writes no list when nothing was discarded", async () => {
		await discard(["tracked.txt"]);
		await discard(["tracked.txt"]);
		expect(discardList()).toBe("tracked.txt\n");

		rmSync(path.join(wt, ".workpilot-discard-list"));
		expect(await discard(["../outside.txt"])).toEqual({
			success: true,
			data: { deleted: [], failed: ["../outside.txt"] },
		});
		expect(existsSync(path.join(wt, ".workpilot-discard-list"))).toBe(false);
	});

	it("reports a file git cannot restore", async () => {
		// Added by the task and not on the base branch: there is no version to check out.
		writeFileSync(path.join(wt, "added.txt"), "task\n", "utf-8");
		git(wt, "add", "added.txt");
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect((await discard(["added.txt"])).data).toEqual({ deleted: [], failed: ["added.txt"] });
		errors.mockRestore();
	});

	it("reports an untracked path it cannot delete", async () => {
		mkdirSync(path.join(wt, "folder"));
		writeFileSync(path.join(wt, "folder", "inner.txt"), "x", "utf-8");
		const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
		// `folder/` is untracked: git lists it with `??`, and unlinking a folder fails.
		expect((await discard(["folder"])).data).toEqual({ deleted: [], failed: ["folder"] });
		errors.mockRestore();
	});
});
