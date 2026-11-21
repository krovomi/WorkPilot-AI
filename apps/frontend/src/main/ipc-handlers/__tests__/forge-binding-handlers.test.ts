/**
 * @vitest-environment node
 *
 * `git:forgeBindings` takes a registered project's id, and only the
 * repository fields of the page's unsaved values: the folder, the settings
 * file and git are the main process's.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

const state = vi.hoisted(() => ({
	project: undefined as
		| { id: string; path: string; autoBuildPath?: string; remote?: unknown }
		| undefined,
	remotes: "",
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: () => state.remotes,
}));
vi.mock("../../cli-tool-manager", () => ({ getToolPath: (tool: string) => tool }));
vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => (state.project?.id === id ? state.project : undefined),
	},
}));

import { forgetGitRemotes } from "../../forge/project-forge-binding";
import {
	currentValues,
	forgeBindingsFor,
	registerForgeBindingHandlers,
} from "../forge-binding-handlers";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "forge-binding-"));
	mkdirSync(path.join(root, ".workpilot"), { recursive: true });
	state.project = { id: "p1", path: root, autoBuildPath: ".workpilot" };
	state.remotes = "origin\thttps://github.com/leub/dotnet.git (fetch)\n";
	forgetGitRemotes();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("forgeBindingsFor", () => {
	it("reports another project's repository saved in the project's settings", () => {
		writeFileSync(path.join(root, ".workpilot", ".env"), "GITHUB_REPO=krovomi/WorkPilot-AI\n");

		const result = forgeBindingsFor("p1");

		expect(result.success).toBe(true);
		expect(result.data?.github).toEqual({
			status: "mismatch",
			saved: "krovomi/WorkPilot-AI",
			candidates: [{ label: "leub/dotnet", fix: { githubRepo: "leub/dotnet" } }],
		});
	});

	it("checks the page's unsaved value in place of the file's", () => {
		writeFileSync(path.join(root, ".workpilot", ".env"), "GITHUB_REPO=krovomi/WorkPilot-AI\n");

		expect(forgeBindingsFor("p1", { githubRepo: "leub/dotnet" }).data?.github.status).toBe("matched");
	});

	it("reads a project that is not initialized as having no settings", () => {
		state.project = { id: "p1", path: root };
		expect(forgeBindingsFor("p1").data?.github.status).toBe("detected");
	});

	it("refuses a malformed id, an unknown project and a server project", () => {
		expect(forgeBindingsFor(42).success).toBe(false);
		expect(forgeBindingsFor("").success).toBe(false);
		expect(forgeBindingsFor("x".repeat(201)).success).toBe(false);
		expect(forgeBindingsFor("nope")).toEqual({ success: false, error: "Project not found" });

		state.project = { id: "p1", path: root, remote: { serverUrl: "https://s.invalid" } };
		expect(forgeBindingsFor("p1")).toEqual({ success: false, error: "Not a local project" });
	});
});

describe("currentValues", () => {
	it("keeps only the repository fields, as bounded strings", () => {
		expect(
			currentValues({
				githubRepo: "a/b",
				gitlabProject: "g/p",
				gitlabInstanceUrl: "https://gitlab.acme.dev",
				azureDevOpsOrgUrl: "https://dev.azure.com/o",
				azureDevOpsProject: "P",
				azureDevOpsRepository: "r",
				githubToken: "pat-test-0000",
				gitlabEnabled: true,
			}),
		).toEqual({
			GITHUB_REPO: "a/b",
			GITLAB_PROJECT: "g/p",
			GITLAB_INSTANCE_URL: "https://gitlab.acme.dev",
			AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/o",
			AZURE_DEVOPS_PROJECT: "P",
			AZURE_DEVOPS_REPOSITORY: "r",
		});
		expect(currentValues({ githubRepo: "x".repeat(1025), gitlabProject: 3 })).toEqual({});
		expect(currentValues(null)).toEqual({});
		expect(currentValues(["a/b"])).toEqual({});
		expect(currentValues("a/b")).toEqual({});
	});
});

describe("registerForgeBindingHandlers", () => {
	it("answers the channel with the project's bindings", async () => {
		registerForgeBindingHandlers();
		const main = ipcMain as unknown as {
			invokeHandler: (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
		};

		const result = (await main.invokeHandler(IPC_CHANNELS.GIT_FORGE_BINDINGS, {}, "p1", {
			githubRepo: "",
		})) as {
			data: { github: { status: string } };
		};

		expect(result.data.github.status).toBe("detected");
	});
});
