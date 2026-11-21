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

	it("never shows the previous project's repository once the project changed", async () => {
		// The first project's answer comes late, after the switch.
		let answerWorkpilot: (value: unknown) => void = () => undefined;
		checkGitHubConnection.mockImplementation((projectId: string) =>
			projectId === "workpilot"
				? new Promise((resolve) => {
						answerWorkpilot = resolve;
					})
				: Promise.resolve({
						success: true,
						data: { connected: true, repoFullName: "acme/dotnet" },
					}),
		);
		listPRs.mockImplementation(async (projectId: string) => ({
			prs: projectId === "dotnet" ? [pr(3, "Bump the SDK")] : [pr(1185, "Browser agent")],
			hasNextPage: false,
			endCursor: null,
		}));

		const { result, rerender } = renderHook(
			({ projectId }: { projectId: string }) =>
				useGitHubPRs(projectId, { isActive: true }),
			{ initialProps: { projectId: "workpilot" } },
		);
		await waitFor(() => expect(checkGitHubConnection).toHaveBeenCalledWith("workpilot"));

		rerender({ projectId: "dotnet" });
		await waitFor(() => expect(result.current.repoFullName).toBe("acme/dotnet"));

		await act(async () => {
			answerWorkpilot({
				success: true,
				data: { connected: true, repoFullName: "krovomi/WorkPilot-AI" },
			});
		});

		expect(result.current.repoFullName).toBe("acme/dotnet");
		expect(result.current.prs.map((p) => p.number)).toEqual([3]);
		expect(listPRs).not.toHaveBeenCalledWith("workpilot");
	});

	it("forgets the previous project's repository as soon as the project changes", async () => {
		checkGitHubConnection.mockImplementation((projectId: string) =>
			projectId === "workpilot"
				? Promise.resolve({
						success: true,
						data: { connected: true, repoFullName: "krovomi/WorkPilot-AI" },
					})
				: new Promise(() => undefined),
		);
		listPRs.mockResolvedValue({ prs: [pr(1185, "Browser agent")], hasNextPage: false, endCursor: null });

		const { result, rerender } = renderHook(
			({ projectId }: { projectId: string }) =>
				useGitHubPRs(projectId, { isActive: true }),
			{ initialProps: { projectId: "workpilot" } },
		);
		await waitFor(() => expect(result.current.repoFullName).toBe("krovomi/WorkPilot-AI"));

		rerender({ projectId: "dotnet" });

		expect(result.current.repoFullName).toBeNull();
		expect(result.current.prs).toEqual([]);
	});

	it("loads nothing before a project is selected", async () => {
		const { rerender } = renderHook(
			({ projectId }: { projectId: string }) => useGitHubPRs(projectId, { isActive: true }),
			{ initialProps: { projectId: "" } },
		);
		await act(async () => {
			rerender({ projectId: "" });
		});
		expect(checkGitHubConnection).not.toHaveBeenCalled();
		expect(listPRs).not.toHaveBeenCalled();
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
