/**
 * @vitest-environment node
 *
 * A GitLab sign-in through the glab CLI: the renderer only holds the mask of
 * glab's token (GITLAB_GET_TOKEN), and saving the settings with the OAuth
 * method and that mask writes the token glab holds now for the settings'
 * instance, read by the main process. A mask without the OAuth method, a
 * typed token or an instance glab cannot name keep their usual meaning.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../../__tests__/helpers/fake-safe-storage";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	project: { id: "p1", path: "", autoBuildPath: ".workpilot" },
	glabToken: null as string | null,
	glabHosts: [] as string[],
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

vi.mock("../gitlab/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../gitlab/utils")>()),
	getGlabToken: async (host: string) => {
		state.glabHosts.push(host);
		return state.glabToken;
	},
}));

const fake = sharedFakeSafeStorage();

beforeEach(async () => {
	fake.reset();
	state.handlers.clear();
	state.glabToken = "glpat-test-0000";
	state.glabHosts = [];
	state.project.path = mkdtempSync(path.join(tmpdir(), "env-glab-oauth-"));
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const { registerEnvHandlers } = await import("../env-handlers");
	registerEnvHandlers(() => null);
});

afterEach(() => {
	rmSync(state.project.path, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function update(config: Record<string, unknown>): Promise<unknown> {
	const handler = state.handlers.get(IPC_CHANNELS.ENV_UPDATE);
	if (!handler) throw new Error("ENV_UPDATE not registered");
	return handler({}, "p1", config);
}

const envFile = () =>
	readFileSync(path.join(state.project.path, ".workpilot", ".env"), "utf-8");

describe("ENV_UPDATE with a glab sign-in", () => {
	it("writes glab's token, encrypted, for the mask sent with the OAuth method", async () => {
		await expect(
			update({
				gitlabToken: MASKED_SECRET,
				gitlabAuthMethod: "oauth",
				gitlabProject: "acme/shop",
			}),
		).resolves.toEqual({ success: true });

		const raw = envFile();
		expect(raw).toContain(`GITLAB_TOKEN=${fakeEncrypted("glpat-test-0000")}`);
		expect(raw).not.toContain(MASKED_SECRET);
		expect(raw).toContain("GITLAB_PROJECT=acme/shop");
		expect(state.glabHosts).toEqual(["gitlab.com"]);
	});

	it("asks glab for the token of the settings' instance", async () => {
		await update({
			gitlabToken: MASKED_SECRET,
			gitlabAuthMethod: "oauth",
			gitlabInstanceUrl: "https://gitlab.acme.dev",
		});

		expect(state.glabHosts).toEqual(["gitlab.acme.dev"]);
		expect(envFile()).toContain(`GITLAB_TOKEN=${fakeEncrypted("glpat-test-0000")}`);
	});

	it("replaces a token saved before with the one glab holds now", async () => {
		await update({ gitlabToken: "pat-test-0000" });

		await update({ gitlabToken: MASKED_SECRET, gitlabAuthMethod: "oauth" });

		expect(envFile()).toContain(`GITLAB_TOKEN=${fakeEncrypted("glpat-test-0000")}`);
	});

	it("keeps the stored token when glab has none, or the instance is not one", async () => {
		await update({ gitlabToken: "pat-test-0000" });
		await update({
			gitlabToken: MASKED_SECRET,
			gitlabAuthMethod: "oauth",
			gitlabInstanceUrl: "ftp://gitlab.acme.dev",
		});
		expect(state.glabHosts).toEqual([]);

		state.glabToken = null;
		await update({ gitlabToken: MASKED_SECRET, gitlabAuthMethod: "oauth" });

		expect(envFile()).toContain(`GITLAB_TOKEN=${fakeEncrypted("pat-test-0000")}`);
	});

	it("leaves a mask without the OAuth method, and a typed token, as they are", async () => {
		await update({ gitlabToken: "pat-test-0000" });
		await update({ gitlabToken: MASKED_SECRET });
		expect(envFile()).toContain(`GITLAB_TOKEN=${fakeEncrypted("pat-test-0000")}`);

		await update({ gitlabToken: "pat-test-1111", gitlabAuthMethod: "oauth" });
		await update({ gitlabAuthMethod: "oauth", gitlabProject: "acme/shop" });

		expect(envFile()).toContain(`GITLAB_TOKEN=${fakeEncrypted("pat-test-1111")}`);
		expect(state.glabHosts).toEqual([]);
	});
});
