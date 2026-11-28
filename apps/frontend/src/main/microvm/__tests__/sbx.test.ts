/** Docker Sandboxes from the main process: the VM name, the status, the removal. */
import { describe, expect, it, vi } from "vitest";
import { microvmName, microvmStatus, removeTaskMicrovm } from "../sbx";

describe("microvmName", () => {
	it("is the backend's name for the same path (tests/os_sandbox/test_microvm.py)", () => {
		// The path as resolved: /home is a link on macOS, and Windows would add a drive.
		const asIs = (worktree: string) => worktree;
		expect(microvmName("/home/me/wt", false, asIs)).toBe("workpilot-194449c0cfe5d0df");
	});
});

describe("microvmStatus", () => {
	it("says when sbx is not there, without running anything", async () => {
		const exec = vi.fn();
		expect(await microvmStatus(exec, null)).toEqual({
			installed: false,
			ready: false,
			version: null,
			vms: 0,
			reason: null,
		});
		expect(exec).not.toHaveBeenCalled();
	});

	it("counts WorkPilot's VMs only when sbx answers", async () => {
		const exec = vi.fn(async (_file: string, args: string[]) =>
			args[0] === "version"
				? { stdout: "sbx 0.54.1\n", stderr: "" }
				: { stdout: JSON.stringify([{ name: "workpilot-1" }, { name: "claude-mine" }, {}]), stderr: "" },
		);
		expect(await microvmStatus(exec, "/opt/sbx")).toEqual({
			installed: true,
			ready: true,
			version: "sbx 0.54.1",
			vms: 1,
			reason: null,
		});
	});

	it("gives sbx's own words when it is not signed in", async () => {
		const exec = vi.fn(async (_file: string, args: string[]) => {
			if (args[0] === "version") return { stdout: "sbx 0.54.1", stderr: "" };
			throw Object.assign(new Error("exit 1"), { stderr: "error: not signed in to Docker\ntry: sbx login" });
		});
		const status = await microvmStatus(exec, "/opt/sbx");
		expect(status).toMatchObject({ installed: true, ready: false, reason: "try: sbx login" });
	});
});

describe("removeTaskMicrovm", () => {
	it("removes the worktree's VM by its name, and is quiet when there is none", async () => {
		const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
		expect(await removeTaskMicrovm("/home/me/wt", exec, "/opt/sbx")).toBe(true);
		expect(exec).toHaveBeenCalledWith("/opt/sbx", ["rm", "--force", microvmName("/home/me/wt")]);
		const missing = vi.fn(async () => {
			throw new Error("no such sandbox");
		});
		expect(await removeTaskMicrovm("/home/me/wt", missing, "/opt/sbx")).toBe(false);
		expect(await removeTaskMicrovm("/home/me/wt", exec, null)).toBe(false);
	});
});
