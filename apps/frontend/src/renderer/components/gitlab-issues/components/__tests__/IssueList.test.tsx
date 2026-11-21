/**
 * The list of GitLab issues: each row says its state in the app's language
 * (never the API's `opened`), opens on click or keyboard, and offers to create
 * a task without selecting the row.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { GitLabIssue } from "../../../../../shared/types";
import { IssueList } from "../IssueList";

const issue = (iid: number, extra: Partial<GitLabIssue> = {}): GitLabIssue => ({
	id: iid * 10,
	iid,
	title: `Issue ${iid}`,
	state: "opened",
	labels: [],
	assignees: [],
	author: { username: "ana" },
	createdAt: "2026-11-01T10:00:00Z",
	updatedAt: "2026-11-01T10:00:00Z",
	userNotesCount: 0,
	webUrl: `https://gitlab.example/team/app/-/issues/${iid}`,
	projectPathWithNamespace: "team/app",
	...extra,
});

function renderList(props: Partial<React.ComponentProps<typeof IssueList>> = {}) {
	const handlers = { onSelectIssue: vi.fn(), onInvestigate: vi.fn() };
	render(
		<IssueList
			issues={[issue(1), issue(2, { state: "closed", userNotesCount: 3, labels: ["bug", "ui"] })]}
			selectedIssueIid={null}
			isLoading={false}
			error={null}
			{...handlers}
			{...props}
		/>,
	);
	return handlers;
}

const row = (title: string) => {
	const found = screen.getByText(title).closest<HTMLElement>("[role='button']");
	if (!found) throw new Error(`no row for ${title}`);
	return found;
};

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

describe("IssueList", () => {
	it("says each issue's state in words, with its notes and labels when it has any", () => {
		renderList();
		expect(within(row("Issue 1")).getByText("Open")).toBeInTheDocument();
		expect(within(row("Issue 2")).getByText("Closed")).toBeInTheDocument();
		expect(within(row("Issue 2")).getByText("3")).toBeInTheDocument();
		expect(within(row("Issue 2")).getByText("2")).toBeInTheDocument();
		expect(within(row("Issue 1")).getByText("ana")).toBeInTheDocument();
		expect(screen.queryByText("opened")).not.toBeInTheDocument();
	});

	it("says the state in French too", async () => {
		await i18n.changeLanguage("fr");
		renderList();
		expect(within(row("Issue 1")).getByText("Ouverte")).toBeInTheDocument();
		expect(within(row("Issue 2")).getByText("Fermée")).toBeInTheDocument();
	});

	it("says there are no issues in French too", async () => {
		await i18n.changeLanguage("fr");
		renderList({ issues: [] });
		expect(screen.getByText("Aucune issue trouvée")).toBeInTheDocument();
	});

	it("opens an issue by click, Enter or Space, and creates a task without opening it", () => {
		const { onSelectIssue, onInvestigate } = renderList({ selectedIssueIid: 2 });
		expect(row("Issue 2").className).toContain("bg-accent/50");
		fireEvent.click(row("Issue 1"));
		fireEvent.keyDown(row("Issue 2"), { key: "Enter" });
		fireEvent.keyDown(row("Issue 2"), { key: " " });
		fireEvent.keyDown(row("Issue 2"), { key: "a" });
		expect(onSelectIssue.mock.calls).toEqual([[1], [2], [2]]);

		fireEvent.click(within(row("Issue 1")).getByRole("button", { name: "Investigate issue" }));
		expect(onInvestigate).toHaveBeenCalledWith(expect.objectContaining({ iid: 1 }));
		expect(onSelectIssue).toHaveBeenCalledTimes(3);
	});

	it("shows why the issues could not be read, a spinner while they load, or that there are none", () => {
		const { unmount } = render(
			<IssueList issues={[]} selectedIssueIid={null} isLoading={false} error="401 Unauthorized" onSelectIssue={vi.fn()} onInvestigate={vi.fn()} />,
		);
		expect(screen.getByText("401 Unauthorized")).toBeInTheDocument();
		unmount();

		const loading = render(
			<IssueList issues={[]} selectedIssueIid={null} isLoading error={null} onSelectIssue={vi.fn()} onInvestigate={vi.fn()} />,
		);
		expect(loading.container.querySelector(".animate-spin")).not.toBeNull();
		loading.unmount();

		renderList({ issues: [] });
		expect(screen.getByText("No issues found")).toBeInTheDocument();
	});
});
