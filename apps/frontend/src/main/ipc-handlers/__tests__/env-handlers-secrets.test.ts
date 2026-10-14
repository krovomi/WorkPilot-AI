/**
 * @vitest-environment node
 *
 * The project settings screen saves integration tokens through ENV_UPDATE.
 * They reach `.workpilot/.env` encrypted, and ENV_GET reads them back.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../__tests__/helpers/fake-safe-storage";
import { IPC_CHANNELS } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: { id: "p1", path: "", autoBuildPath: ".workpilot" },
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
	projectStore: {
		getProject: (id: string) =>
			id === state.project.id ? state.project : undefined,
		updateAutoBuildPath: vi.fn(),
	},
}));

vi.mock("../../settings-utils", () => ({ readSettingsFile: () => ({}) }));

vi.mock("../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => tool,
	getToolPathAsync: async (tool: string) => tool,
}));

const fake = sharedFakeSafeStorage();

describe("ENV_UPDATE / ENV_GET secrets", () => {
	beforeEach(async () => {
		fake.reset();
		state.handlers.clear();
		state.project.path = mkdtempSync(path.join(tmpdir(), "env-handlers-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { registerEnvHandlers } = await import("../env-handlers");
		registerEnvHandlers(() => null);
	});

	afterEach(() => {
		rmSync(state.project.path, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = state.handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		return handler({}, ...args);
	}

	it("writes the tokens encrypted and reads them back", async () => {
		await expect(
			invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
				claudeOAuthToken: "sk-ant-oat01-secret",
				githubEnabled: true,
				githubToken: "ghp_secret",
				githubRepo: "owner/repo",
				linearApiKey: "lin_api_secret",
			}),
		).resolves.toEqual({ success: true });

		const envPath = path.join(state.project.path, ".workpilot", ".env");
		const raw = readFileSync(envPath, "utf-8");
		expect(raw).not.toContain("secret");
		expect(raw).toContain(`GITHUB_TOKEN=${fakeEncrypted("ghp_secret")}`);
		expect(raw).toContain("GITHUB_REPO=owner/repo");

		const result = (await invoke(IPC_CHANNELS.ENV_GET, "p1")) as {
			success: boolean;
			data: Record<string, unknown>;
		};
		expect(result.success).toBe(true);
		expect(result.data.githubToken).toBe("ghp_secret");
		expect(result.data.linearApiKey).toBe("lin_api_secret");
		expect(result.data.claudeOAuthToken).toBe("sk-ant-oat01-secret");
	});

	it("keeps a token saved earlier when another field changes", async () => {
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { githubToken: "ghp_secret" });
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { githubRepo: "owner/repo" });

		const raw = readFileSync(
			path.join(state.project.path, ".workpilot", ".env"),
			"utf-8",
		);
		expect(raw).toContain(`GITHUB_TOKEN=${fakeEncrypted("ghp_secret")}`);
		expect(raw).toContain("GITHUB_REPO=owner/repo");
	});

	it("keeps the keys other screens wrote (Figma, CI/CD triggers)", async () => {
		const envPath = path.join(state.project.path, ".workpilot", ".env");
		const { writeProjectEnvFile } = await import("../../project-env-file");
		writeProjectEnvFile(
			envPath,
			"FIGMA_ACCESS_TOKEN=figd_secret\nCICD_GITHUB_TOKEN=ghp_cicd_secret\nCICD_AUTO_TRIGGER=true\n",
		);

		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { githubRepo: "owner/repo" });

		const raw = readFileSync(envPath, "utf-8");
		expect(raw).toContain("GITHUB_REPO=owner/repo");
		expect(raw).toContain(`FIGMA_ACCESS_TOKEN=${fakeEncrypted("figd_secret")}`);
		expect(raw).toContain(
			`CICD_GITHUB_TOKEN=${fakeEncrypted("ghp_cicd_secret")}`,
		);
		expect(raw).toContain("CICD_AUTO_TRIGGER=true");
		expect(raw).not.toContain("secret");
	});
});
