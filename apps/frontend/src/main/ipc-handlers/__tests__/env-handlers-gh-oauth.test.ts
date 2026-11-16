/**
 * @vitest-environment node
 *
 * A GitHub sign-in through the gh CLI: the renderer only holds the mask of
 * gh's token (GITHUB_GET_TOKEN), and saving the settings with the OAuth
 * method and that mask writes the token gh holds now, read by the main
 * process. A mask without the OAuth method, a typed token or an empty one
 * keep their usual meaning.
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
	ghToken: null as string | null,
	ghCalls: 0,
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

vi.mock("../github/utils", () => ({
	getGitHubTokenForSubprocess: async () => {
		state.ghCalls += 1;
		return state.ghToken;
	},
}));

const fake = sharedFakeSafeStorage();

beforeEach(async () => {
	fake.reset();
	state.handlers.clear();
	state.ghToken = "gho-test-0000";
	state.ghCalls = 0;
	state.project.path = mkdtempSync(path.join(tmpdir(), "env-gh-oauth-"));
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

describe("ENV_UPDATE with a gh sign-in", () => {
	it("writes gh's token, encrypted, for the mask sent with the OAuth method", async () => {
		await expect(
			update({
				githubToken: MASKED_SECRET,
				githubAuthMethod: "oauth",
				githubRepo: "acme/shop",
			}),
		).resolves.toEqual({ success: true });

		const raw = envFile();
		expect(raw).toContain(`GITHUB_TOKEN=${fakeEncrypted("gho-test-0000")}`);
		expect(raw).not.toContain(MASKED_SECRET);
		expect(raw).toContain("GITHUB_REPO=acme/shop");
	});

	it("replaces a token saved before with the one gh holds now", async () => {
		await update({ githubToken: "pat-test-0000", githubAuthMethod: "pat" });

		await update({ githubToken: MASKED_SECRET, githubAuthMethod: "oauth" });

		expect(envFile()).toContain(`GITHUB_TOKEN=${fakeEncrypted("gho-test-0000")}`);
	});

	it("keeps the stored token when gh has none", async () => {
		await update({ githubToken: "pat-test-0000" });
		state.ghToken = null;

		await update({ githubToken: MASKED_SECRET, githubAuthMethod: "oauth" });

		expect(envFile()).toContain(`GITHUB_TOKEN=${fakeEncrypted("pat-test-0000")}`);
	});

	it("leaves the mask alone without the OAuth method: it keeps the stored token", async () => {
		await update({ githubToken: "pat-test-0000" });

		await update({ githubToken: MASKED_SECRET, githubAuthMethod: "pat" });
		await update({ githubToken: MASKED_SECRET });

		expect(envFile()).toContain(`GITHUB_TOKEN=${fakeEncrypted("pat-test-0000")}`);
		expect(state.ghCalls).toBe(0);
	});

	it("stores a typed token as typed, and asks gh nothing without a token field", async () => {
		await update({ githubToken: "pat-test-1111", githubAuthMethod: "oauth" });
		await update({ githubAuthMethod: "oauth", githubRepo: "acme/shop" });

		expect(envFile()).toContain(`GITHUB_TOKEN=${fakeEncrypted("pat-test-1111")}`);
		expect(state.ghCalls).toBe(0);
	});
});
