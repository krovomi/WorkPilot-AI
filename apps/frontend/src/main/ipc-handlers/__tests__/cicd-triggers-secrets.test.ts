/**
 * @vitest-environment node
 *
 * The CI/CD triggers screen keeps its tokens in `.workpilot/.env`, encrypted,
 * never in the project's root `.env`. The renderer is not trusted: it names a
 * directory that must be one of the user's projects, and only the settings in
 * a closed list are written.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../__tests__/helpers/fake-safe-storage";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	projects: [] as Array<{ id: string; path: string; autoBuildPath: string }>,
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: { getPath: () => tmpdir(), getAppPath: () => tmpdir() },
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: Handler) =>
				state.handlers.set(channel, handler),
		},
	};
});

vi.mock("../../project-store", () => ({
	projectStore: { getProjects: () => state.projects },
}));

vi.mock("../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => tool,
	getToolPathAsync: async (tool: string) => tool,
}));

vi.mock("../../python-env-manager", () => ({
	getConfiguredPythonPath: () => "python3",
}));

const fake = sharedFakeSafeStorage();

describe("CI/CD triggers settings", () => {
	let projectDir: string;
	let envPath: string;

	beforeEach(async () => {
		fake.reset();
		state.handlers.clear();
		projectDir = mkdtempSync(path.join(tmpdir(), "cicd-triggers-"));
		envPath = path.join(projectDir, ".workpilot", ".env");
		state.projects = [
			{ id: "p1", path: projectDir, autoBuildPath: ".workpilot" },
		];
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { registerCICDTriggersHandlers } = await import(
			"../cicd-triggers-handlers"
		);
		registerCICDTriggersHandlers();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = state.handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		// Some handlers are synchronous: what ipcMain.handle resolves either way.
		return Promise.resolve(handler({}, ...args));
	}

	it("writes the tokens encrypted to .workpilot/.env, not the root .env", async () => {
		await expect(
			invoke("cicdTriggers:setConfig", projectDir, {
				provider: "github",
				enabled: true,
				github_token: "ghp_cicd_secret",
				github_workflow: "deploy.yml",
			}),
		).resolves.toEqual({ success: true });

		expect(existsSync(path.join(projectDir, ".env"))).toBe(false);
		const raw = readFileSync(envPath, "utf-8");
		expect(raw).not.toContain("ghp_cicd_secret");
		expect(raw).toContain(
			`CICD_GITHUB_TOKEN=${fakeEncrypted("ghp_cicd_secret")}`,
		);
		expect(raw).toContain("CICD_PROVIDER=github");
		expect(raw).toContain("CICD_AUTO_TRIGGER=true");
		expect(raw).toContain("CICD_GITHUB_WORKFLOW=deploy.yml");
	});

	it("shows a set token masked and keeps it when the mask comes back", async () => {
		await invoke("cicdTriggers:setConfig", projectDir, {
			github_token: "ghp_cicd_secret",
		});

		const shown = (await invoke("cicdTriggers:getConfig", projectDir)) as {
			data: Record<string, unknown>;
		};
		expect(shown.data.github_token).toBe("***");
		expect(shown.data.enabled).toBe(false);

		await invoke("cicdTriggers:setConfig", projectDir, {
			...shown.data,
			enabled: true,
		});

		const raw = readFileSync(envPath, "utf-8");
		expect(raw).toContain(
			`CICD_GITHUB_TOKEN=${fakeEncrypted("ghp_cicd_secret")}`,
		);
		expect(raw).not.toContain("CICD_GITHUB_TOKEN=***");
		expect(
			((await invoke("cicdTriggers:getConfig", projectDir)) as {
				data: Record<string, unknown>;
			}).data.enabled,
		).toBe(true);
	});

	it("refuses a directory that is not one of the user's projects", async () => {
		const elsewhere = mkdtempSync(path.join(tmpdir(), "not-a-project-"));
		try {
			for (const [channel, ...args] of [
				["cicdTriggers:setConfig", elsewhere, { github_token: "ghp_x" }],
				["cicdTriggers:getConfig", elsewhere],
				["cicdTriggers:listRuns", elsewhere],
				["cicdTriggers:trigger", elsewhere, { provider: "github" }],
				["cicdTriggers:getRunStatus", elsewhere, "1"],
				["cicdTriggers:cancelRun", elsewhere, "1"],
				["cicdTriggers:setConfig", 42, {}],
			] as Array<[string, ...unknown[]]>) {
				await expect(invoke(channel, ...args), channel).resolves.toEqual({
					success: false,
					error: "Project not found",
				});
			}
			expect(existsSync(path.join(elsewhere, ".env"))).toBe(false);
			expect(existsSync(path.join(elsewhere, ".workpilot"))).toBe(false);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	it("refuses a value that would add lines to the file", async () => {
		await expect(
			invoke("cicdTriggers:setConfig", projectDir, {
				github_ref: "main\nLD_PRELOAD=/tmp/evil.so",
			}),
		).resolves.toEqual({ success: false, error: "invalid-value" });
		expect(existsSync(envPath)).toBe(false);
	});

	it("writes only the settings it knows", async () => {
		const { toCicdEnvUpdate } = await import("../cicd-triggers-handlers");

		expect(
			toCicdEnvUpdate({
				provider: "jenkins",
				jenkins_token: "",
				node_options: "--require /tmp/x.js",
				"provider=x\nY": "z",
			}),
		).toEqual({
			ok: true,
			update: { CICD_PROVIDER: "jenkins", CICD_JENKINS_TOKEN: "" },
		});
		expect(toCicdEnvUpdate(null)).toEqual({
			ok: false,
			error: "invalid-config",
		});
	});

	it("leaves the user's own root .env untouched", async () => {
		writeFileSync(path.join(projectDir, ".env"), "PORT=3000\n");

		await invoke("cicdTriggers:setConfig", projectDir, { provider: "gitlab" });

		expect(readFileSync(path.join(projectDir, ".env"), "utf-8")).toBe(
			"PORT=3000\n",
		);
	});
});
