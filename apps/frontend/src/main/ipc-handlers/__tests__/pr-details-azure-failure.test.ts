/**
 * An Azure DevOps PR the connector cannot read is an error: the handler used
 * to answer with an invented PR (author, files, labels) reported as success.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ app: { getPath: () => "/tmp" }, ipcMain: { handle: vi.fn() } }));
vi.mock("../github/utils", () => ({ getGitHubConfig: vi.fn(), githubFetch: vi.fn() }));
vi.mock("../task/shared", () => ({ findTaskAndProject: vi.fn() }));
vi.mock("../../project-env-file", () => ({ readProjectEnv: vi.fn(() => ({})) }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const mocked = { ...actual, spawn: mockSpawn };
	return { ...mocked, default: mocked };
});

import type { Project } from "../../../shared/types";
import { getAzureDevOpsPRDetails } from "../pr-details-handlers";

const URL = "https://dev.azure.com/org/proj/_git/repo/pullrequest/7";
const PROJECT = { id: "p1", path: "/projects/demo" } as Project;

function fakePython(stdout: string, code: number) {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	queueMicrotask(() => {
		child.stdout.emit("data", Buffer.from(stdout));
		child.emit("close", code);
	});
	return child;
}

describe("getAzureDevOpsPRDetails", () => {
	it("reports a missing PAT as an error, with no invented PR", async () => {
		mockSpawn.mockReturnValueOnce(
			fakePython(JSON.stringify({ error: "AZURE_DEVOPS_PAT not set" }), 1),
		);

		const result = await getAzureDevOpsPRDetails(7, URL, PROJECT);

		expect(result.success).toBe(false);
		expect(result.data).toBeUndefined();
		expect(result.error).toBeTruthy();
	});

	it("reports a Python that cannot start as an error", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdout: EventEmitter;
			stderr: EventEmitter;
		};
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => child.emit("error", new Error("spawn python ENOENT")));
		mockSpawn.mockReturnValueOnce(child);

		const result = await getAzureDevOpsPRDetails(7, URL, PROJECT);

		expect(result).toEqual({ success: false, error: "spawn python ENOENT" });
	});
});
