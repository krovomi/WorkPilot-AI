/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import type { PurgeCandidate } from "../../../shared/types/worktree-purge";

const { loadTasksMock } = vi.hoisted(() => ({ loadTasksMock: vi.fn() }));
vi.mock("../../stores/task-store", () => ({ loadTasks: loadTasksMock }));

import { formatBytes, WorktreePurgeButton } from "./WorktreePurgeButton";

const MB = 1024 * 1024;
const candidates: PurgeCandidate[] = [
	{ taskId: "001", specId: "001", title: "Login page", reason: "merged", path: "/p/001", bytes: 300 * MB, dirty: false },
	{ taskId: "002", specId: "002", title: "Old spike", reason: "abandoned", path: "/p/002", bytes: 200 * MB, dirty: false },
	{ taskId: "003", specId: "003", title: "Half done", reason: "done", path: "/p/003", bytes: 50 * MB, dirty: true },
];
const list = vi.fn();
const purge = vi.fn();

beforeEach(() => {
	loadTasksMock.mockReset();
	list.mockReset().mockResolvedValue({ success: true, data: candidates });
	purge.mockReset().mockResolvedValue({
		success: true,
		data: [
			{ specId: "001", purged: true, bytes: 300 * MB },
			{ specId: "002", purged: true, bytes: 200 * MB },
		],
	});
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
		listPurgeableWorktrees: list,
		purgeWorktrees: purge,
	};
});

describe("WorktreePurgeButton", () => {
	it("lists the finished worktrees with the room they take, uncommitted ones kept", async () => {
		render(<WorktreePurgeButton projectId="p1" />);
		fireEvent.click(screen.getByTestId("worktree-purge-button"));

		await screen.findByText("Login page");
		expect(list).toHaveBeenCalledWith("p1");
		expect(screen.getByText("PR merged")).toBeInTheDocument();
		expect(screen.getByText("uncommitted changes, kept")).toBeInTheDocument();
		const boxes = screen.getAllByRole("checkbox");
		expect(boxes[2]).toBeDisabled();
		expect(screen.getByRole("button", { name: /Purge 2 worktrees \(500 MB\)/ })).toBeInTheDocument();
	});

	it("purges the chosen ones and says how much room was freed", async () => {
		render(<WorktreePurgeButton projectId="p1" />);
		fireEvent.click(screen.getByTestId("worktree-purge-button"));
		await screen.findByText("Login page");

		fireEvent.click(screen.getByRole("checkbox", { name: "Old spike" }));
		fireEvent.click(screen.getByRole("button", { name: /Purge 1 worktree \(300 MB\)/ }));

		await waitFor(() => expect(purge).toHaveBeenCalledWith("p1", ["001"]));
		expect(await screen.findByText(/2 worktrees purged, 500 MB freed/)).toBeInTheDocument();
		// The board reloads once the result is read, not under it.
		expect(loadTasksMock).not.toHaveBeenCalled();
		fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		await waitFor(() => expect(loadTasksMock).toHaveBeenCalledWith("p1", { forceRefresh: true }));
	});

	it("says when there is nothing to purge", async () => {
		list.mockResolvedValueOnce({ success: true, data: [] });
		render(<WorktreePurgeButton projectId="p1" />);
		fireEvent.click(screen.getByTestId("worktree-purge-button"));
		expect(await screen.findByText(/No worktree to purge/)).toBeInTheDocument();
	});
});

describe("formatBytes", () => {
	// Intl puts a narrow no-break space in French.
	const plain = (text: string) => text.replace(/\s/g, " ");

	it("follows the app's language", () => {
		expect(plain(formatBytes(1.5 * 1024 * MB, "fr"))).toBe("1,5 Go");
		expect(plain(formatBytes(1.5 * 1024 * MB, "en"))).toBe("1.5 GB");
		expect(plain(formatBytes(512, "en"))).toBe("512 byte");
	});
});
