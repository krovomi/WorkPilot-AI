/**
 * Spec Approval only reads the spec files a person reviews; the decision goes
 * through the task's review channel. The spec id picks a directory listed in
 * `.workpilot/specs`, never a path of its own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
			handlers.set(channel, fn);
		},
	},
}));

import {
	findSpecDir,
	registerSpecApprovalHandlers,
} from "../spec-approval-handlers";

let project: string;

beforeEach(() => {
	project = mkdtempSync(path.join(tmpdir(), "spec-approval-"));
	const spec = path.join(project, ".workpilot", "specs", "001-add-login");
	mkdirSync(spec, { recursive: true });
	writeFileSync(path.join(spec, "spec.md"), "# Login", "utf-8");
	writeFileSync(path.join(spec, "implementation_plan.json"), "{}", "utf-8");
	handlers.clear();
	registerSpecApprovalHandlers();
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

describe("spec approval handlers", () => {
	it("registers only the read channel", () => {
		expect([...handlers.keys()]).toEqual([IPC_CHANNELS.SPEC_APPROVAL_GET_SPEC]);
	});

	it("finds a spec by its directory name or its number", () => {
		const expected = path.join(project, ".workpilot", "specs", "001-add-login");
		expect(findSpecDir(project, "001-add-login")).toBe(expected);
		expect(findSpecDir(project, "001")).toBe(expected);
		expect(findSpecDir(project, "002-other")).toBeNull();
	});

	it("does not follow an id that names a path", () => {
		expect(findSpecDir(project, "../../etc")).toBeNull();
	});

	it("returns the spec files for review", async () => {
		const get = handlers.get(IPC_CHANNELS.SPEC_APPROVAL_GET_SPEC);
		const result = (await get?.({}, project, "001-add-login")) as {
			success: boolean;
			data: Record<string, string>;
		};
		expect(result.success).toBe(true);
		expect(result.data.spec_md).toBe("# Login");
		expect(result.data.implementation_plan_json).toBe("{}");
		expect(result.data.requirements_json).toBeUndefined();
	});

	it("answers not found for an unknown or empty id", async () => {
		const get = handlers.get(IPC_CHANNELS.SPEC_APPROVAL_GET_SPEC);
		expect(await get?.({}, project, "")).toEqual({
			success: false,
			error: "Spec not found",
		});
		expect(await get?.({}, project, "999")).toEqual({
			success: false,
			error: "Spec not found",
		});
	});
});
