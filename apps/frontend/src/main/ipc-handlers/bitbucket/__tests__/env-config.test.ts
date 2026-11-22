/**
 * @vitest-environment node
 *
 * The Bitbucket keys of a project's `.workpilot/.env` through ENV_UPDATE and
 * ENV_GET: the token is written `enc:` and reaches the renderer only as
 * MASKED_SECRET; a repository typed as `workspace/repo` or a clone URL is
 * stored as its two slugs.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../../__tests__/helpers/fake-safe-storage";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../../shared/constants";
import type { ProjectEnvConfig } from "../../../../shared/types";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: { id: "p1", path: "", autoBuildPath: ".workpilot" },
	globalSettings: {} as Record<string, unknown>,
	backendFetch: vi.fn(),
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../../../__tests__/helpers/fake-safe-storage"
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

vi.mock("../../../project-store", () => ({
	projectStore: {
		getProject: (id: string) =>
			id === state.project.id ? state.project : undefined,
		updateAutoBuildPath: vi.fn(),
	},
}));

vi.mock("../../../settings-utils", () => ({
	readSettingsFile: () => state.globalSettings,
}));

vi.mock("../../_backend-fetch", () => ({ backendFetch: state.backendFetch }));

vi.mock("../../../cli-tool-manager", () => ({
	getToolPath: (tool: string) => tool,
	getToolPathAsync: async (tool: string) => tool,
}));

const fake = sharedFakeSafeStorage();

describe("Bitbucket project settings", () => {
	beforeEach(async () => {
		fake.reset();
		state.handlers.clear();
		state.project.path = mkdtempSync(path.join(tmpdir(), "bb-env-"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { registerEnvHandlers } = await import("../../env-handlers");
		registerEnvHandlers(() => null);
	});

	afterEach(() => {
		rmSync(state.project.path, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	const invoke = (channel: string, ...args: unknown[]) => {
		const handler = state.handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		return handler({}, ...args);
	};
	const envFile = () =>
		readFileSync(path.join(state.project.path, ".workpilot", ".env"), "utf-8");
	const getConfig = async () =>
		((await invoke(IPC_CHANNELS.ENV_GET, "p1")) as { data: ProjectEnvConfig }).data;

	it("stores the token encrypted and shows the renderer only its mask", async () => {
		await expect(
			invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
				bitbucketEnabled: true,
				bitbucketUsername: "dev@example.com",
				bitbucketToken: "bb-test-0000",
				bitbucketRepo: "https://dev@bitbucket.org/acme/web-app.git",
				bitbucketAutoSync: true,
			}),
		).resolves.toEqual({ success: true });
		const raw = envFile();
		expect(raw).not.toContain("bb-test-0000");
		expect(raw).toContain(`BITBUCKET_TOKEN=${fakeEncrypted("bb-test-0000")}`);
		expect(raw).toContain("BITBUCKET_WORKSPACE=acme");
		expect(raw).toContain("BITBUCKET_REPO=web-app");

		const config = await getConfig();
		expect(JSON.stringify(config)).not.toContain("bb-test-0000");
		expect(config).toMatchObject({
			bitbucketEnabled: true,
			bitbucketToken: MASKED_SECRET,
			bitbucketWorkspace: "acme",
			bitbucketRepo: "web-app",
			bitbucketUsername: "dev@example.com",
			bitbucketAutoSync: true,
		});
	});

	it("keeps the stored token when its mask comes back, and an empty field never erases one", async () => {
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
			bitbucketToken: "bb-test-0000",
			bitbucketWorkspace: "acme",
			bitbucketRepo: "api",
		});
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", {
			bitbucketToken: MASKED_SECRET,
			bitbucketWorkspace: "",
			bitbucketRepo: "",
			bitbucketEnabled: false,
		});
		const raw = envFile();
		expect(raw).toContain(`BITBUCKET_TOKEN=${fakeEncrypted("bb-test-0000")}`);
		expect(raw).toContain("BITBUCKET_WORKSPACE=acme");
		expect(raw).toContain("BITBUCKET_REPO=api");
		const config = await getConfig();
		expect(config.bitbucketEnabled).toBe(false);
		expect(config.bitbucketAutoSync).toBe(false);
	});

	it("reads a token without BITBUCKET_ENABLED as enabled, and nothing as disabled", async () => {
		expect((await getConfig()).bitbucketEnabled).toBe(false);
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { bitbucketToken: "bb-test-0000" });
		expect(envFile()).toContain("# BITBUCKET_ENABLED=false");
		expect((await getConfig()).bitbucketEnabled).toBe(true);
	});

	it("writes `workspace/repo` as two slugs, and keeps a repository it cannot parse as typed", async () => {
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { bitbucketRepo: "team/site" });
		expect(envFile()).toContain("BITBUCKET_WORKSPACE=team");
		await invoke(IPC_CHANNELS.ENV_UPDATE, "p1", { bitbucketRepo: "a/b/c" });
		const raw = envFile();
		expect(raw).toContain("BITBUCKET_REPO=a/b/c");
		expect(raw).toContain("BITBUCKET_WORKSPACE=team");
	});
});
