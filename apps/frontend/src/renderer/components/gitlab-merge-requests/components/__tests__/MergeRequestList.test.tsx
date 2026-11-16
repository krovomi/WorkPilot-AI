/**
 * The list of GitLab MRs: its filters, its search and each row.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { GitLabMergeRequest } from "../../../../../shared/types";
import { MergeRequestList } from "../MergeRequestList";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`gitlab:${key}`, options ?? {});

const mr = (
	iid: number,
	over: Partial<GitLabMergeRequest> = {},
): GitLabMergeRequest => ({
	id: 1000 + iid,
	iid,
	title: `MR ${iid}`,
	state: "opened",
	sourceBranch: `feat/${iid}`,
	targetBranch: "main",
	author: { username: "dana" },
	assignees: [],
	labels: [],
	webUrl: `https://gitlab.example/group/app/-/merge_requests/${iid}`,
	createdAt: "2026-11-01T09:00:00Z",
	updatedAt: "2026-11-01T09:00:00Z",
	mergeStatus: "can_be_merged",
	...over,
});

const MRS = [
	mr(1, { title: "Add the export", labels: ["a", "b", "c", "d", "e"] }),
	mr(2, { title: "Fix login", sourceBranch: "hotfix/sso", state: "merged" }),
	mr(12, { title: "Drop old API", state: "closed" }),
	mr(4, { title: "Pin deps", state: "locked" }),
];

function setup(over: Partial<React.ComponentProps<typeof MergeRequestList>> = {}) {
	const props: React.ComponentProps<typeof MergeRequestList> = {
		mergeRequests: MRS,
		isLoading: false,
		selectedMrIid: null,
		onSelectMr: vi.fn(),
		onRefresh: vi.fn(),
		stateFilter: "opened",
		onStateFilterChange: vi.fn(),
		...over,
	};
	render(<MergeRequestList {...props} />);
	return { props, user: userEvent.setup() };
}

const rows = () =>
	screen
		.queryAllByRole("button", { pressed: false })
		.concat(screen.queryAllByRole("button", { pressed: true }))
		.filter((b) => b.textContent?.includes("!"))
		.map((b) => within(b).getByRole("heading").textContent);

describe("MergeRequestList", () => {
	it("lists each MR with its branches, labels, author and link", () => {
		setup({ selectedMrIid: 2 });

		expect(rows()).toHaveLength(4);
		expect(screen.getByText("hotfix/sso")).toBeInTheDocument();
		expect(screen.getByText("+2")).toBeInTheDocument();
		expect(screen.queryByText("d")).not.toBeInTheDocument();
		expect(
			screen.getAllByText(t("mergeRequests.byAuthor", { author: "dana" })),
		).toHaveLength(4);
		const links = screen.getAllByRole("link", {
			name: i18n.t("common:accessibility.openOnGitLabAriaLabel"),
		});
		expect(links[0]).toHaveAttribute("href", MRS[0].webUrl);
		expect(links[0]).toHaveAttribute("target", "_blank");
		expect(
			screen.getByRole("button", { pressed: true, name: /Fix login/ }),
		).toBeInTheDocument();
	});

	it("opens the MR clicked", async () => {
		const { props, user } = setup();
		await user.click(screen.getByRole("button", { name: /Drop old API/ }));
		expect(props.onSelectMr).toHaveBeenCalledWith(MRS[2]);
	});

	it("searches titles, branches and numbers", async () => {
		const { user } = setup();
		const search = screen.getByPlaceholderText(t("mergeRequests.searchPlaceholder"));

		await user.type(search, "  LOGIN ");
		expect(rows()).toEqual(["Fix login"]);

		await user.clear(search);
		await user.type(search, "hotfix/");
		expect(rows()).toEqual(["Fix login"]);

		await user.clear(search);
		await user.type(search, "!12");
		expect(rows()).toEqual(["Drop old API"]);

		await user.clear(search);
		await user.type(search, "nothing like it");
		expect(screen.getByText(t("mergeRequests.noMatch"))).toBeInTheDocument();
	});

	it("filters by state and shows which filter is on", async () => {
		const { props, user } = setup({ stateFilter: "merged" });

		expect(
			screen.getByRole("button", { name: t("mergeRequests.filters.merged") }),
		).toHaveAttribute("aria-pressed", "true");
		await user.click(
			screen.getByRole("button", { name: t("mergeRequests.filters.all") }),
		);
		expect(props.onStateFilterChange).toHaveBeenCalledWith("all");
	});

	it("refreshes on demand", async () => {
		const { props, user } = setup();
		const refresh = screen.getByRole("button", {
			name: i18n.t("common:accessibility.refreshAriaLabel"),
		});
		await user.click(refresh);
		expect(props.onRefresh).toHaveBeenCalledTimes(1);
	});

	it("shows a spinner on the first load and keeps the rows on a reload", () => {
		setup({ isLoading: true, mergeRequests: [] });
		expect(
			screen.getByRole("button", {
				name: i18n.t("common:accessibility.refreshAriaLabel"),
			}),
		).toBeDisabled();
		expect(screen.queryByText(t("mergeRequests.empty"))).not.toBeInTheDocument();
	});

	it("keeps the rows while it reloads", () => {
		setup({ isLoading: true });
		expect(rows()).toHaveLength(4);
	});

	it("says when there is no MR at all", () => {
		setup({ mergeRequests: [] });
		expect(screen.getByText(t("mergeRequests.empty"))).toBeInTheDocument();
	});
});
