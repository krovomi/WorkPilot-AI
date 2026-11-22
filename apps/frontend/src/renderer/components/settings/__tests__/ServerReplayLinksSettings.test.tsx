/**
 * The person's own team links to a replay, in Settings (server mode, #347):
 * every link on every project, with Revoke on the open ones; revoking lists
 * them again, and a refusal is said.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayMyTeamShare } from "../../../../shared/types/replay-share";
import { useReplayUsageStore } from "../../../stores/replay-usage-store";
import { ServerReplayLinksSettings } from "../ServerReplayLinksSettings";

const api = {
	listMyReplayTeamShares: vi.fn(),
	revokeReplayTeamShare: vi.fn(),
};

const mine = (id: string, extra: Partial<ReplayMyTeamShare> = {}): ReplayMyTeamShare => ({
	id,
	title: `Title ${id}`,
	steps: 3,
	createdBy: "Ada",
	createdAt: "2026-11-21T10:00:00Z",
	expiresAt: "2026-11-28T10:00:00Z",
	state: "active",
	openCount: 2,
	canRevoke: true,
	projectId: `p-${id}`,
	projectName: `Shop ${id}`,
	...extra,
});

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useReplayUsageStore.setState({ mine: null, mineLoading: false, mineError: null });
});

afterEach(cleanup);

describe("ServerReplayLinksSettings", () => {
	it("lists every link with its project, and revokes an open one", async () => {
		api.listMyReplayTeamShares
			.mockResolvedValueOnce({
				success: true,
				shares: [mine("a"), mine("b", { state: "expired" })],
			})
			.mockResolvedValueOnce({ success: true, shares: [mine("a", { state: "revoked" })] });
		api.revokeReplayTeamShare.mockResolvedValueOnce({ success: true });
		render(<ServerReplayLinksSettings />);

		expect(await screen.findByText("Title a")).toBeInTheDocument();
		expect(screen.getByText("Project: Shop a")).toBeInTheDocument();
		expect(screen.getByText("Expired")).toBeInTheDocument();
		// Only the open link can be revoked.
		const revoke = screen.getAllByRole("button", { name: "Revoke" });
		expect(revoke).toHaveLength(1);
		fireEvent.click(revoke[0]);

		await waitFor(() => expect(screen.getByText("Revoked")).toBeInTheDocument());
		expect(api.revokeReplayTeamShare).toHaveBeenCalledWith("p-a", "a");
		expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
	});

	it("says when there is no link, and refreshes on demand", async () => {
		api.listMyReplayTeamShares.mockResolvedValue({ success: true, shares: [] });
		render(<ServerReplayLinksSettings />);
		expect(await screen.findByText("You have not made any team link yet.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(api.listMyReplayTeamShares).toHaveBeenCalledTimes(2));
	});

	it("says why the list or a revocation failed", async () => {
		api.listMyReplayTeamShares.mockResolvedValueOnce({ success: false, error: "not_signed_in" });
		render(<ServerReplayLinksSettings />);
		expect(
			await screen.findByText("Sign in to your WorkPilot server to open a team link."),
		).toBeInTheDocument();

		api.revokeReplayTeamShare.mockResolvedValueOnce({
			success: false,
			error: "share_not_found",
		});
		await useReplayUsageStore.getState().revokeMine(mine("x"));
		expect(useReplayUsageStore.getState().mineError?.key).toBe(
			"replay:share.errors.share_not_found",
		);
		expect(api.listMyReplayTeamShares).toHaveBeenCalledTimes(1);
	});

	it("shows a spinner while it lists", async () => {
		api.listMyReplayTeamShares.mockReturnValue(new Promise(() => undefined));
		render(<ServerReplayLinksSettings />);
		await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled());
	});
});
