/**
 * The GitLab MR view: the list beside the open MR, the actions it routes to
 * that MR, the dialog that opens a new one, and what it shows when GitLab
 * cannot be reached. The MR state hook and the MR page are stand-ins; each
 * has its own tests.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { GitLabMergeRequest } from "../../../../shared/types";
import { GitLabMergeRequests } from "../GitLabMergeRequests";

const hook = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const useGitLabMRs = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useGitLabMRs", () => ({ useGitLabMRs }));
vi.mock("../components/MRDetail", () => ({
	MRDetail: (p: Record<string, (arg?: unknown) => unknown> & { mr: GitLabMergeRequest }) => (
		<section aria-label="mr page">
			<h2>{p.mr.title}</h2>
			{[
				"onRunReview",
				"onRunFollowupReview",
				"onCheckNewCommits",
				"onCancelReview",
				"onApproveMR",
			].map((name) => (
				<button key={name} type="button" onClick={() => p[name]()}>
					{name}
				</button>
			))}
			<button type="button" onClick={() => p.onPostReview(["a"])}>
				onPostReview
			</button>
			<button type="button" onClick={() => p.onMergeMR("rebase")}>
				onMergeMR
			</button>
		</section>
	),
}));

const t = (key: string) => i18n.t(`gitlab:${key}`);

const MR: GitLabMergeRequest = {
	id: 1007,
	iid: 7,
	title: "Add the export",
	state: "opened",
	sourceBranch: "feat/export",
	targetBranch: "main",
	author: { username: "dana" },
	assignees: [],
	labels: [],
	webUrl: "https://gitlab.example/group/app/-/merge_requests/7",
	createdAt: "2026-11-01T09:00:00Z",
	updatedAt: "2026-11-01T09:00:00Z",
	mergeStatus: "can_be_merged",
};

const actions = [
	"selectMR",
	"refresh",
	"runReview",
	"runFollowupReview",
	"checkNewCommits",
	"cancelReview",
	"postReview",
	"mergeMR",
	"approveMR",
] as const;

function state(over: Record<string, unknown> = {}) {
	hook.value = {
		mergeRequests: [MR],
		isLoading: false,
		error: null,
		selectedMR: null,
		selectedMRIid: null,
		reviewResult: null,
		reviewProgress: null,
		isReviewing: false,
		...Object.fromEntries(actions.map((name) => [name, vi.fn(async () => true)])),
		...over,
	};
	return hook.value as Record<(typeof actions)[number], ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
	useGitLabMRs.mockImplementation(() => hook.value);
	state();
});

describe("GitLabMergeRequests", () => {
	it("lists the open MRs and asks to pick one", () => {
		render(<GitLabMergeRequests projectId="p1" />);

		expect(useGitLabMRs).toHaveBeenCalledWith("p1", { stateFilter: "opened" });
		expect(screen.getByRole("button", { name: /Add the export/ })).toBeInTheDocument();
		expect(screen.getByText(t("mergeRequests.selectMR"))).toBeInTheDocument();
	});

	it("reloads the list for the filter picked", async () => {
		const user = userEvent.setup();
		render(<GitLabMergeRequests projectId="p1" />);

		await user.click(
			screen.getByRole("button", { name: t("mergeRequests.filters.merged") }),
		);
		expect(useGitLabMRs).toHaveBeenLastCalledWith("p1", {
			stateFilter: "merged",
		});
	});

	it("opens the MR clicked", async () => {
		const fns = state();
		const user = userEvent.setup();
		render(<GitLabMergeRequests projectId="p1" />);

		await user.click(screen.getByRole("button", { name: /Add the export/ }));
		expect(fns.selectMR).toHaveBeenCalledWith(7);
	});

	it("routes every action of the open MR to it", async () => {
		const fns = state({ selectedMR: MR, selectedMRIid: 7 });
		const user = userEvent.setup();
		render(<GitLabMergeRequests projectId="p1" />);

		const page = screen.getByRole("region", { name: "mr page" });
		for (const button of page.querySelectorAll("button")) {
			await user.click(button);
		}

		for (const name of [
			"runReview",
			"runFollowupReview",
			"checkNewCommits",
			"cancelReview",
			"approveMR",
		] as const) {
			expect(fns[name]).toHaveBeenCalledWith(7);
		}
		expect(fns.postReview).toHaveBeenCalledWith(7, ["a"]);
		expect(fns.mergeMR).toHaveBeenCalledWith(7, "rebase");
	});

	it("opens the new MR once the dialog created it", async () => {
		const fns = state();
		(window as unknown as { electronAPI: unknown }).electronAPI = {
			createGitLabMergeRequest: vi.fn(async () => ({
				success: true,
				data: { iid: 9 },
			})),
		};
		const user = userEvent.setup();
		render(<GitLabMergeRequests projectId="p1" />);

		await user.click(screen.getByRole("button", { name: t("mergeRequests.newMR") }));
		await user.type(
			screen.getByLabelText(t("mergeRequests.create.titleLabel")),
			"New one",
		);
		await user.type(
			screen.getByLabelText(t("mergeRequests.create.sourceBranch")),
			"feat/new",
		);
		await user.click(
			screen.getByRole("button", { name: t("mergeRequests.create.title") }),
		);

		expect(fns.refresh).toHaveBeenCalled();
		expect(fns.selectMR).toHaveBeenCalledWith(9);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
	});

	it("offers a retry and the settings when GitLab cannot be reached", async () => {
		const fns = state({ error: "401 Unauthorized" });
		const onOpenSettings = vi.fn();
		const user = userEvent.setup();
		render(<GitLabMergeRequests projectId="p1" onOpenSettings={onOpenSettings} />);

		expect(screen.getByText("401 Unauthorized")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: t("mergeRequests.tryAgain") }),
		);
		await user.click(
			screen.getByRole("button", { name: t("notConnected.openSettings") }),
		);
		expect(fns.refresh).toHaveBeenCalledTimes(1);
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});

	it("offers only the retry when there is no settings page to open", () => {
		state({ error: "timeout" });
		render(<GitLabMergeRequests projectId="p1" />);
		expect(
			screen.queryByRole("button", { name: t("notConnected.openSettings") }),
		).not.toBeInTheDocument();
	});
});
