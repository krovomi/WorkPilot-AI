/**
 * @vitest-environment jsdom
 */
/**
 * The PR list stays mounted (hidden) across views and projects: switching
 * to another project loads that project's pull requests, and opening the
 * view again refreshes them. The project-change reset also ran on mount and
 * cleared the "loaded" flag, so opening the view never refreshed: a person
 * who added their GitHub token after the first load kept reading "GitHub
 * not connected".
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGitHubPRs } from "../useGitHubPRs";

const checkGitHubConnection = vi.fn();
const listPRs = vi.fn();
const getPRReviewsBatch = vi.fn();

function pr(number: number, title: string) {
	return {
		number,
		title,
		body: "",
		state: "open",
		author: { login: "erin" },
		headRefName: "feat",
		baseRefName: "main",
		additions: 1,
		deletions: 0,
		changedFiles: 1,
		assignees: [],
		createdAt: "2026-11-01T09:00:00Z",
		updatedAt: "2026-11-10T16:30:00Z",
		htmlUrl: `https://github.com/acme/site/pull/${number}`,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		github: { checkGitHubConnection, listPRs, getPRReviewsBatch },
	};
	getPRReviewsBatch.mockResolvedValue({});
});

describe("useGitHubPRs across projects", () => {
	it("loads the pull requests of the project switched to", async () => {
		checkGitHubConnection.mockImplementation(async (projectId: string) => ({
			success: true,
			data:
				projectId === "site"
					? { connected: true, repoFullName: "acme/site" }
					: { connected: false },
		}));
		listPRs.mockResolvedValue({
			prs: [pr(12, "Add a welcome banner")],
			hasNextPage: false,
			endCursor: null,
		});

		const { result, rerender } = renderHook(
			({ projectId }: { projectId: string }) =>
				useGitHubPRs(projectId, { isActive: false }),
			{ initialProps: { projectId: "board" } },
		);
		await waitFor(() => expect(checkGitHubConnection).toHaveBeenCalledWith("board"));
		expect(result.current.isConnected).toBe(false);

		rerender({ projectId: "site" });

		await waitFor(() => expect(result.current.isConnected).toBe(true));
		expect(checkGitHubConnection).toHaveBeenLastCalledWith("site");
		expect(listPRs).toHaveBeenCalledWith("site");
		expect(result.current.prs.map((p) => p.number)).toEqual([12]);
	});

	it("refreshes the project's list when the view is opened again", async () => {
		checkGitHubConnection.mockResolvedValue({
			success: true,
			data: { connected: true, repoFullName: "acme/site" },
		});
		listPRs.mockResolvedValue({ prs: [], hasNextPage: false, endCursor: null });

		const { rerender } = renderHook(
			({ isActive }: { isActive: boolean }) => useGitHubPRs("site", { isActive }),
			{ initialProps: { isActive: false } },
		);
		await waitFor(() => expect(listPRs).toHaveBeenCalledTimes(1));

		await act(async () => {
			rerender({ isActive: true });
		});
		await waitFor(() => expect(listPRs).toHaveBeenCalledTimes(2));
	});
});
