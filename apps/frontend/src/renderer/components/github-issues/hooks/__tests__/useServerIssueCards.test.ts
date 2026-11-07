/**
 * @vitest-environment jsdom
 */
/**
 * "Create Task" on an issue of a server project makes a card of its shared
 * board, shows it on the board right away, links the issue to it, and opens
 * it; a refusal is shown where the issues are.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../../shared/types";
import { useIssuesStore } from "../../../../stores/github/issues-store";
import { useGitLabStore } from "../../../../stores/gitlab-store";
import { useTaskStore } from "../../../../stores/task-store";
import { useServerIssueCards } from "../useServerIssueCards";

const importGitHubIssues = vi.fn();
const importGitLabIssues = vi.fn();

beforeEach(() => {
	importGitHubIssues.mockReset();
	importGitLabIssues.mockReset();
	(window as unknown as { electronAPI: unknown }).electronAPI = {
		importGitHubIssues,
		importGitLabIssues,
	};
	useGitLabStore.getState().setError(null);
	useTaskStore.setState({ tasks: [] });
	useIssuesStore.getState().setError(null);
});

describe("useServerIssueCards", () => {
	it("makes the issue a card, links it and opens it", async () => {
		const card = { id: "server:p-1:c-1", title: "Checkout fails" } as Task;
		importGitHubIssues.mockResolvedValue({
			success: true,
			data: { success: true, imported: 1, failed: 0, tasks: [card] },
		});
		const open = vi.fn();
		const { result } = renderHook(() => useServerIssueCards("p-1", open));

		await act(() => result.current.createCard(3));

		expect(importGitHubIssues).toHaveBeenCalledWith("p-1", [3]);
		expect(useTaskStore.getState().tasks.map((t) => t.id)).toEqual([card.id]);
		expect(result.current.created.get(3)).toBe(card.id);
		expect(open).toHaveBeenCalledWith(card.id);
		expect(result.current.creating).toBeNull();
	});

	it("shows the server's refusal", async () => {
		importGitHubIssues.mockResolvedValue({
			success: true,
			data: {
				success: false,
				imported: 0,
				failed: 1,
				errors: ["Failed to import #3: Missing permission: board.card.create"],
				tasks: [],
			},
		});
		const open = vi.fn();
		const { result } = renderHook(() => useServerIssueCards("p-1", open));

		await act(() => result.current.createCard(3));

		expect(useIssuesStore.getState().error).toMatch(/Missing permission/);
		expect(result.current.created.size).toBe(0);
		expect(open).not.toHaveBeenCalled();
	});

	it("makes a GitLab issue a card, and shows a refusal in the GitLab view", async () => {
		const card = { id: "server:p-1:c-2", title: "Login loops" } as Task;
		importGitLabIssues.mockResolvedValueOnce({
			success: true,
			data: { success: true, imported: 1, failed: 0, tasks: [card] },
		});
		const open = vi.fn();
		const { result } = renderHook(() => useServerIssueCards("p-1", open, "gitlab"));

		await act(() => result.current.createCard(12));

		expect(importGitLabIssues).toHaveBeenCalledWith("p-1", [12]);
		expect(importGitHubIssues).not.toHaveBeenCalled();
		expect(result.current.created.get(12)).toBe(card.id);
		expect(open).toHaveBeenCalledWith(card.id);

		importGitLabIssues.mockResolvedValueOnce({ success: false, error: "Server unavailable" });
		await act(() => result.current.createCard(13));
		expect(useGitLabStore.getState().error).toBe("Server unavailable");
		expect(useIssuesStore.getState().error).toBeNull();
	});
});
