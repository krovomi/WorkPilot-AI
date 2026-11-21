/**
 * Team links to a replay (#347): the share dialog offers them only for a
 * server project where the person is a member, shows the new link once with
 * a copy button, lists the project's links and revokes one; a pasted link
 * opens beside Import, only when the app knows a server project.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";
import { useProjectStore } from "../../../stores/project-store";
import { useReplayShareStore } from "../../../stores/replay-share-store";
import { useReplayTeamShareStore } from "../../../stores/replay-team-share-store";
import { ReplayShareButton } from "../ReplaySharing";
import { ReplayOpenLinkButton, ReplayTeamShareSection } from "../ReplayTeamShare";

const api = {
	listReplayTeamShares: vi.fn(),
	shareReplayToTeam: vi.fn(),
	revokeReplayTeamShare: vi.fn(),
	openReplayTeamShare: vi.fn(),
};

const project = (id: string, role?: "viewer" | "member" | "owner") =>
	({
		id,
		name: `Project ${id}`,
		path: `/mirror/${id}`,
		...(role ? { remote: { repoUrl: "https://x/y.git", defaultBranch: "main", role } } : {}),
	}) as unknown as Project;

const share = (id: string, extra: object = {}) => ({
	id,
	title: `Title ${id}`,
	steps: 3,
	createdBy: "Ada",
	createdAt: "2026-11-21T10:00:00Z",
	expiresAt: "2026-11-28T10:00:00Z",
	state: "active",
	openCount: 4,
	canRevoke: true,
	...extra,
});

const options = { stripReasoning: true, stripTokens: false, includeFileContents: false };
const writeText = vi.fn();

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.listReplayTeamShares.mockResolvedValue({ success: true, shares: [] });
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	Object.assign(navigator, { clipboard: { writeText } });
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
	useReplayTeamShareStore.setState({
		shares: {},
		loading: false,
		sharing: false,
		opening: false,
		lastLink: null,
		error: null,
	});
	useReplayShareStore.setState({ notice: null });
	useProjectStore.setState({ projects: [] });
});

afterEach(cleanup);

describe("ReplayTeamShareSection", () => {
	it("is not offered without a server project where the person may write", () => {
		useProjectStore.setState({ projects: [project("local"), project("v", "viewer")] });
		const { container } = render(
			<ReplayTeamShareSection sessionId="s1" options={options} />,
		);
		expect(container).toBeEmptyDOMElement();
		expect(api.listReplayTeamShares).not.toHaveBeenCalled();
	});

	it("makes a link for the chosen project and lifetime, shows it once, copies it", async () => {
		useProjectStore.setState({ projects: [project("a", "member"), project("b", "owner")] });
		api.shareReplayToTeam.mockResolvedValueOnce({
			success: true,
			link: "workpilot-replay://srv/b/x#token",
			share: share("new"),
		});
		render(<ReplayTeamShareSection sessionId="s1" options={options} />);
		await waitFor(() => expect(api.listReplayTeamShares).toHaveBeenCalledWith("a"));
		expect(await screen.findByText("No link yet.")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Project"), {
			target: { value: "b" },
		});
		await waitFor(() => expect(api.listReplayTeamShares).toHaveBeenCalledWith("b"));
		fireEvent.change(screen.getByLabelText("Lasts"), {
			target: { value: "30" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create the link" }));

		const link = await screen.findByLabelText("Link to send");
		expect(link).toHaveValue("workpilot-replay://srv/b/x#token");
		expect(api.shareReplayToTeam).toHaveBeenCalledWith("s1", {
			projectId: "b",
			ttlDays: 30,
			...options,
		});
		expect(screen.getByText("Title new")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		await waitFor(() =>
			expect(writeText).toHaveBeenCalledWith("workpilot-replay://srv/b/x#token"),
		);
		expect(
			await screen.findByRole("button", { name: "Copied" }),
		).toBeInTheDocument();
	});

	it("says while it creates and why it failed", async () => {
		useProjectStore.setState({ projects: [project("a", "member")] });
		useReplayTeamShareStore.setState({
			sharing: true,
			error: { tone: "error", key: "replay:share.errors.too_many_shares" },
		});
		render(<ReplayTeamShareSection sessionId="s1" options={options} />);
		expect(screen.getByRole("button", { name: "Creating the link…" })).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(
			/as many open links as it may keep/,
		);
	});

	it("lists the project's links, and revokes only those it may", async () => {
		useProjectStore.setState({ projects: [project("a", "member")] });
		const shares = [
			share("mine"),
			share("theirs", { canRevoke: false }),
			share("ended", { state: "expired" }),
		];
		api.listReplayTeamShares.mockResolvedValue({ success: true, shares });
		api.revokeReplayTeamShare.mockResolvedValueOnce({ success: true });
		render(<ReplayTeamShareSection sessionId="s1" options={options} />);
		expect(await screen.findByText("Title mine")).toBeInTheDocument();
		expect(screen.getAllByText("Opened 4 times")).toHaveLength(3);
		const revoke = screen.getAllByRole("button", { name: "Revoke" });
		expect(revoke).toHaveLength(1);
		fireEvent.click(revoke[0]);
		await waitFor(() => expect(api.revokeReplayTeamShare).toHaveBeenCalledWith("a", "mine"));
	});

	it("says it is loading before the first list", () => {
		useProjectStore.setState({ projects: [project("a", "member")] });
		api.listReplayTeamShares.mockReturnValue(new Promise(() => undefined));
		render(<ReplayTeamShareSection sessionId="s1" options={options} />);
		expect(screen.getByText("Loading the links…")).toBeInTheDocument();
	});

	it("forgets the link when the dialog closes", () => {
		useProjectStore.setState({ projects: [project("a", "member")] });
		useReplayTeamShareStore.setState({ lastLink: { projectId: "a", link: "l" } });
		const { unmount } = render(<ReplayTeamShareSection sessionId="s1" options={options} />);
		unmount();
		expect(useReplayTeamShareStore.getState().lastLink).toBeNull();
	});

	it("sits in the share dialog, with its masking options", async () => {
		useProjectStore.setState({ projects: [project("a", "owner")] });
		render(<ReplayShareButton sessionId="s1" />);
		fireEvent.click(screen.getByRole("button", { name: /Share/ }));
		expect(
			await screen.findByRole("region", { name: "Team link" }),
		).toBeInTheDocument();
	});
});

describe("ReplayOpenLinkButton", () => {
	it("is not offered without a server project", () => {
		useProjectStore.setState({ projects: [project("local")] });
		const { container } = render(<ReplayOpenLinkButton />);
		expect(container).toBeEmptyDOMElement();
	});

	it("opens a pasted link and closes", async () => {
		useProjectStore.setState({ projects: [project("a", "viewer")] });
		api.openReplayTeamShare.mockResolvedValueOnce({
			success: true,
			session: { session_id: "n", agent_name: "coder" },
		});
		render(<ReplayOpenLinkButton />);
		fireEvent.click(screen.getByRole("button", { name: /Open a team link/ }));
		const submit = screen.getByRole("button", { name: "Open" });
		expect(submit).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Link"), {
			target: { value: "workpilot-replay://srv/a/x#t" },
		});
		fireEvent.click(submit);
		await waitFor(() =>
			expect(api.openReplayTeamShare).toHaveBeenCalledWith("workpilot-replay://srv/a/x#t"),
		);
		await waitFor(() =>
			expect(screen.queryByLabelText("Link")).not.toBeInTheDocument(),
		);
	});

	it("keeps the pasted text when the link did not open", async () => {
		useProjectStore.setState({ projects: [project("a", "member")] });
		api.openReplayTeamShare.mockResolvedValueOnce({ success: false, error: "share_revoked" });
		useReplayTeamShareStore.setState({ opening: false });
		render(<ReplayOpenLinkButton />);
		fireEvent.click(screen.getByRole("button", { name: /Open a team link/ }));
		fireEvent.change(screen.getByLabelText("Link"), {
			target: { value: "bad" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Open" }));
		await waitFor(() => expect(api.openReplayTeamShare).toHaveBeenCalled());
		expect(useReplayShareStore.getState().notice?.key).toBe(
			"replay:share.errors.share_revoked",
		);
		fireEvent.click(screen.getByRole("button", { name: /Open a team link/ }));
		expect(screen.getByLabelText("Link")).toHaveValue("bad");
	});

	it("says while it opens", () => {
		useProjectStore.setState({ projects: [project("a", "member")] });
		useReplayTeamShareStore.setState({ opening: true });
		render(<ReplayOpenLinkButton />);
		fireEvent.click(screen.getByRole("button", { name: /Open a team link/ }));
		expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();
	});
});
