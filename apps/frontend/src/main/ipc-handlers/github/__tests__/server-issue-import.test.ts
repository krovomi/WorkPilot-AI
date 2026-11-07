/**
 * "Create Task" on an issue of a server project: the issue is read through
 * the server and becomes a card of the project's shared board. No spec is
 * written in the app's mirror and no agent starts on this computer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../../shared/constants";
import type { Project } from "../../../../shared/types";

const handlers = vi.hoisted(() => new Map<string, Function>());
const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	createServerCard: vi.fn(),
	createSpecForIssue: vi.fn(),
	startSpecCreation: vi.fn(),
	project: undefined as unknown,
}));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: Function) => handlers.set(channel, handler),
	},
}));
vi.mock("../../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../../server-board-actions", () => ({
	createServerCard: mocks.createServerCard,
}));
vi.mock("../../server-feature-files", () => ({
	featureProject: (id: unknown) => (id === "p-1" ? mocks.project : undefined),
}));
vi.mock("../spec-utils", () => ({ createSpecForIssue: mocks.createSpecForIssue }));
vi.mock("../../shared/issue-attachments", () => ({
	attachGitHubIssueImages: vi.fn(),
}));

import type { AgentManager } from "../../../agent";
import { registerImportIssues } from "../import-handlers";

function importIssues(...args: unknown[]) {
	const handler = handlers.get(IPC_CHANNELS.GITHUB_IMPORT_ISSUES);
	if (!handler) throw new Error("handler not registered");
	return handler({}, ...args);
}

beforeEach(() => {
	handlers.clear();
	for (const mock of [
		mocks.authedFetch,
		mocks.createServerCard,
		mocks.createSpecForIssue,
		mocks.startSpecCreation,
	]) {
		mock.mockReset();
	}
	mocks.project = {
		id: "p-1",
		path: "/nowhere/mirror",
		remote: {
			repoUrl: "https://github.com/acme/shop.git",
			defaultBranch: "main",
			role: "member",
		},
	} as unknown as Project;
	registerImportIssues({
		startSpecCreation: mocks.startSpecCreation,
	} as unknown as AgentManager);
});

describe("an issue of a server project", () => {
	it("becomes a card of the shared board", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: true,
			data: {
				status: 200,
				body: {
					number: 3,
					title: "Checkout fails",
					body: "Steps…",
					labels: [{ name: "bug" }],
					html_url: "https://github.com/acme/shop/issues/3",
				},
			},
		});
		const card = { id: "server:p-1:c-1", title: "Checkout fails" };
		mocks.createServerCard.mockResolvedValue({ success: true, data: card });

		const result = await importIssues("p-1", [3]);

		expect(result).toEqual({
			success: true,
			data: { success: true, imported: 1, failed: 0, errors: undefined, tasks: [card] },
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/forge/github/read?project_id=p-1",
			"POST",
			{ method: "GET", endpoint: "/repos/acme/shop/issues/3" },
		);
		const [project, title, description] = mocks.createServerCard.mock.calls[0];
		expect(project).toBe(mocks.project);
		expect(title).toBe("Checkout fails");
		expect(description).toContain("[#3](https://github.com/acme/shop/issues/3)");
		expect(description).toContain("Steps…");
		expect(mocks.createSpecForIssue).not.toHaveBeenCalled();
		expect(mocks.startSpecCreation).not.toHaveBeenCalled();
	});

	it("refuses an issue number that is not one, before any call", async () => {
		const result = await importIssues("p-1", ["3/../../other", 0, 2.5]);
		expect(result.data.failed).toBe(3);
		expect(mocks.authedFetch).not.toHaveBeenCalled();
		expect(mocks.createServerCard).not.toHaveBeenCalled();
		expect(await importIssues("p-1", "3")).toMatchObject({
			data: { imported: 0, failed: 0 },
		});
	});
});
