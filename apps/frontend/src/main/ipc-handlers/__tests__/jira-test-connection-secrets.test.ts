/**
 * @vitest-environment node
 *
 * The Jira settings screen holds the mask ENV_GET hands it, not the token.
 * Testing the connection with the mask uses the project's stored token; the
 * mask is never passed to Jira as if it were one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, MASKED_SECRET } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	spawn: vi.fn(),
}));

vi.mock("electron", () => ({
	app: { getPath: () => "/tmp", getAppPath: () => "/tmp" },
	safeStorage: {
		isEncryptionAvailable: () => false,
		getSelectedStorageBackend: () => "basic_text",
	},
	ipcMain: {
		handle: (channel: string, handler: Handler) =>
			state.handlers.set(channel, handler),
	},
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: state.spawn,
}));

vi.mock("../../project-store", () => ({
	projectStore: { getProject: () => undefined, getProjects: () => [] },
}));

describe("jira:testConnection with a masked token", () => {
	beforeEach(async () => {
		state.handlers.clear();
		state.spawn.mockReset();
		const { registerJiraHandlers } = await import("../jira-handlers");
		registerJiraHandlers(
			{} as Parameters<typeof registerJiraHandlers>[0],
			() => null,
		);
	});

	it("is refused without a project whose stored token it stands for", async () => {
		const handler = state.handlers.get(IPC_CHANNELS.JIRA_TEST_CONNECTION);
		if (!handler) throw new Error("no handler");

		for (const input of [
			{
				instanceUrl: "https://example.atlassian.net",
				email: "someone@example.com",
				apiToken: MASKED_SECRET,
			},
			{
				projectId: "unknown",
				instanceUrl: "https://example.atlassian.net",
				email: "someone@example.com",
				apiToken: MASKED_SECRET,
			},
		]) {
			await expect(handler({}, input)).resolves.toEqual({
				success: false,
				error: "Jira credentials are required",
			});
		}
		expect(state.spawn).not.toHaveBeenCalled();
	});
});
