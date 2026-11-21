/** @vitest-environment jsdom */
/**
 * The Jira and Azure DevOps import side panels: what they read through the
 * main process (once per opening, never in a loop), how they filter, select
 * and drag items to the board, and how they resize, collapse and close.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { AzureDevOpsWorkItem, JiraWorkItem } from "../../../../shared/types/integrations";
import { AzureDevOpsSidePanel } from "../../azure-devops-import/AzureDevOpsSidePanel";
import { JiraSidePanel } from "../../jira-import/JiraSidePanel";

const api = {
	checkJiraConnection: vi.fn(),
	getJiraIssues: vi.fn(),
	getJiraIssue: vi.fn(),
	checkAzureDevOpsConnection: vi.fn(),
	getAzureDevOpsWorkItems: vi.fn(),
	getAzureDevOpsWorkItem: vi.fn(),
	detectAzureDevOpsRepository: vi.fn(),
};

const issue = (id: string, over: Partial<JiraWorkItem> = {}): JiraWorkItem => ({
	id,
	title: `Issue ${id}`,
	state: "To Do",
	workItemType: "Task",
	tags: [],
	...over,
});

const workItem = (id: number, over: Partial<AzureDevOpsWorkItem> = {}): AzureDevOpsWorkItem => ({
	id,
	title: `Item ${id}`,
	state: "New",
	workItemType: "Bug",
	tags: [],
	...over,
});

const ISSUES = [
	issue("PROJ-1", {
		title: "Login fails",
		workItemType: "Bug",
		priority: "High",
		assignedTo: "Dana",
		description: "Steps in the attachment",
		tags: ["auth", "web", "urgent", "beta"],
	}),
	issue("PROJ-2", { title: "Add export", workItemType: "Story", state: "In Progress", priority: "Unusual" }),
	issue("PROJ-3", { title: "Write docs", workItemType: "Custom" }),
];

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((r, j) => {
		resolve = r;
		reject = j;
	});
	return { promise, resolve, reject };
}

const onOpenChange = vi.fn();
const onOpenSettings = vi.fn();

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	onOpenChange.mockReset();
	onOpenSettings.mockReset();
	localStorage.clear();
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	api.checkJiraConnection.mockResolvedValue({
		success: true,
		data: { connected: true, projectKey: "PROJ", instanceUrl: "https://jira.example.test" },
	});
	api.getJiraIssues.mockResolvedValue({ success: true, data: ISSUES });
	api.checkAzureDevOpsConnection.mockResolvedValue({
		success: true,
		data: { connected: true, projectName: "Fabrikam" },
	});
	api.getAzureDevOpsWorkItems.mockResolvedValue({ success: true, data: [] });
	api.detectAzureDevOpsRepository.mockResolvedValue({ success: true, data: { repository: "web-app" } });
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function jira(props: Partial<Parameters<typeof JiraSidePanel>[0]> = {}) {
	return render(
		<JiraSidePanel projectId="p1" open onOpenChange={onOpenChange} onOpenSettings={onOpenSettings} {...props} />,
	);
}

const panel = () => screen.getByRole("region", { name: "Jira import panel" });
// The drag ghost is a copy of the row in the page: rows are looked up in the panel.
const inPanel = () => within(document.querySelector("section") as HTMLElement);
const row = (id: string) => inPanel().getByRole("button", { name: new RegExp(`^${id}`) });
const rows = () => screen.queryAllByRole("button", { pressed: false }).concat(screen.queryAllByRole("button", { pressed: true }));
const shownIds = () =>
	screen
		.queryAllByRole("button")
		.filter((b) => b.hasAttribute("aria-pressed"))
		.map((b) => b.querySelector(".font-mono")?.textContent);

async function openJira(props: Partial<Parameters<typeof JiraSidePanel>[0]> = {}) {
	const view = jira(props);
	await screen.findByText("Login fails");
	return view;
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("JiraSidePanel: reading the issues", () => {
	it("renders nothing and reads nothing while closed", async () => {
		const { container } = jira({ open: false });
		await wait(10);
		expect(container).toBeEmptyDOMElement();
		expect(api.checkJiraConnection).not.toHaveBeenCalled();
	});

	it("checks the connection and lists the issues once per opening", async () => {
		const { rerender } = await openJira();
		expect(screen.getByRole("heading", { name: "Import issues from PROJ" })).toBeInTheDocument();
		expect(panel()).toHaveTextContent("Project: PROJ(https://jira.example.test)");
		expect(api.getJiraIssues).toHaveBeenCalledWith("p1", 100);

		// Re-renders (typing, selecting) never check or list again.
		fireEvent.change(screen.getByLabelText("Search issues..."), { target: { value: "a" } });
		fireEvent.click(row("PROJ-2"));
		await wait(20);
		expect(api.checkJiraConnection).toHaveBeenCalledTimes(1);
		expect(api.getJiraIssues).toHaveBeenCalledTimes(1);

		// Closing then opening checks again, and the list kept for five minutes is reused.
		rerender(<JiraSidePanel projectId="p1" open={false} onOpenChange={onOpenChange} />);
		rerender(<JiraSidePanel projectId="p1" open onOpenChange={onOpenChange} />);
		await waitFor(() => expect(api.checkJiraConnection).toHaveBeenCalledTimes(2));
		await wait(10);
		expect(api.getJiraIssues).toHaveBeenCalledTimes(1);
	});

	it("shows how each issue reads", async () => {
		await openJira();
		const first = row("PROJ-1");
		expect(within(first).getByText("Bug").className).toContain("text-destructive");
		expect(within(first).getByText("High").className).toContain("text-orange-500");
		expect(within(first).getByText("Assignee: Dana")).toBeInTheDocument();
		expect(within(first).getByText("Steps in the attachment")).toBeInTheDocument();
		expect(within(first).getByText("urgent")).toBeInTheDocument();
		expect(within(first).queryByText("beta")).not.toBeInTheDocument();
		expect(within(first).getByText("+1")).toBeInTheDocument();
		const second = row("PROJ-2");
		expect(within(second).getByText("Story").className).toContain("text-success");
		expect(within(second).getByText("Unusual").className).toContain("text-gray-500");
		expect(within(second).queryByText(/Assignee/)).not.toBeInTheDocument();
		expect(within(row("PROJ-3")).getByText("Custom").className).toContain("text-gray-500");
	});

	it("colors every Jira type and priority it knows", async () => {
		api.getJiraIssues.mockResolvedValue({
			success: true,
			data: [
				issue("A-1", { workItemType: "Epic", priority: "Highest" }),
				issue("A-2", { workItemType: "Sub-task", priority: "Critical" }),
				issue("A-3", { workItemType: "Task", priority: "Medium" }),
				issue("A-4", { priority: "Low" }),
				issue("A-5", { priority: "Lowest" }),
			],
		});
		jira();
		await screen.findByText("Issue A-1");
		expect(within(row("A-1")).getByText("Epic").className).toContain("text-orange-500");
		expect(within(row("A-1")).getByText("Highest").className).toContain("text-destructive");
		expect(within(row("A-2")).getByText("Sub-task").className).toContain("text-cyan-500");
		expect(within(row("A-2")).getByText("Critical").className).toContain("text-destructive");
		expect(within(row("A-3")).getByText("Task").className).toContain("text-blue-500");
		expect(within(row("A-3")).getByText("Medium").className).toContain("text-warning");
		expect(within(row("A-4")).getByText("Low").className).toContain("text-blue-500");
		expect(within(row("A-5")).getByText("Lowest").className).toContain("text-gray-500");
	});

	it("names the generic title and no project line without a project key", async () => {
		api.checkJiraConnection.mockResolvedValue({ success: true, data: { connected: true } });
		jira();
		await screen.findByText("Login fails");
		expect(screen.getByRole("heading", { name: "Import Jira Issues" })).toBeInTheDocument();
		expect(panel()).not.toHaveTextContent("Project:");
	});

	it("shows the project without an address when Jira gave none", async () => {
		api.checkJiraConnection.mockResolvedValue({ success: true, data: { connected: true, projectKey: "PROJ" } });
		await openJira();
		expect(panel()).toHaveTextContent("Project: PROJ");
		expect(panel()).not.toHaveTextContent("(");
	});

	it("says why Jira cannot be reached, and offers its settings", async () => {
		const cases: [unknown, string][] = [
			[{ success: true, data: { connected: false, error: "Token expired" } }, "Token expired"],
			[{ success: true, data: { connected: false } }, "Jira not configured"],
			[{ success: true }, "Jira not configured"],
			[{ success: false, error: "Main refused" }, "Main refused"],
			[{ success: false }, "Connection check failed"],
		];
		for (const [answer, message] of cases) {
			api.checkJiraConnection.mockResolvedValueOnce(answer);
			jira();
			expect(await screen.findByRole("alert")).toHaveTextContent(message);
			expect(screen.queryByLabelText("Search issues...")).not.toBeInTheDocument();
			cleanup();
		}
		api.checkJiraConnection.mockRejectedValueOnce(new Error("IPC gone"));
		jira();
		expect(await screen.findByRole("alert")).toHaveTextContent("IPC gone");
		cleanup();
		api.checkJiraConnection.mockRejectedValueOnce("gone");
		jira({ onOpenSettings: undefined });
		expect(await screen.findByRole("alert")).toHaveTextContent("Unknown error");
		expect(screen.queryByRole("button", { name: "Configure Jira" })).not.toBeInTheDocument();
		cleanup();

		api.checkJiraConnection.mockResolvedValueOnce({ success: false });
		jira();
		fireEvent.click(await screen.findByRole("button", { name: "Configure Jira" }));
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
		expect(api.getJiraIssues).not.toHaveBeenCalled();
	});

	it("says why the issues could not be read, once, without reading again", async () => {
		api.getJiraIssues.mockResolvedValueOnce({ success: false, error: "JQL refused" });
		jira();
		expect(await screen.findByRole("alert")).toHaveTextContent("JQL refused");
		await wait(20);
		expect(api.getJiraIssues).toHaveBeenCalledTimes(1);
		cleanup();

		api.getJiraIssues.mockResolvedValueOnce({ success: false });
		jira();
		expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load issues");
		cleanup();

		api.getJiraIssues.mockRejectedValueOnce(new Error("Timed out"));
		jira();
		expect(await screen.findByRole("alert")).toHaveTextContent("Timed out");
		cleanup();

		api.getJiraIssues.mockRejectedValueOnce(42);
		jira();
		expect(await screen.findByRole("alert")).toHaveTextContent("Unknown error");
		cleanup();

		api.getJiraIssues.mockResolvedValueOnce({ success: true });
		jira();
		expect(await screen.findByText("No Jira issues found")).toBeInTheDocument();
		expect(screen.queryByText("Try adjusting your filters")).not.toBeInTheDocument();
		expect(screen.queryByRole("checkbox", { name: "Select all" })).not.toBeInTheDocument();
	});

	it("shows a spinner while reading", async () => {
		const answer = deferred<unknown>();
		api.getJiraIssues.mockReturnValue(answer.promise);
		jira();
		await waitFor(() => expect(api.getJiraIssues).toHaveBeenCalled());
		expect(panel().querySelector(".h-8.animate-spin")).not.toBeNull();
		await act(async () => answer.resolve({ success: true, data: ISSUES }));
		expect(panel().querySelector(".h-8.animate-spin")).toBeNull();
	});

	it("drops an answer for a project the panel has left, and the list of the previous one", async () => {
		const slow = deferred<unknown>();
		api.getJiraIssues.mockImplementation((projectId: string) =>
			projectId === "p1" ? slow.promise : Promise.resolve({ success: true, data: [issue("OTHER-1")] }),
		);
		const { rerender } = jira();
		await waitFor(() => expect(api.getJiraIssues).toHaveBeenCalledWith("p1", 100));
		rerender(<JiraSidePanel projectId="p2" open onOpenChange={onOpenChange} />);
		expect(await screen.findByText("Issue OTHER-1")).toBeInTheDocument();
		await act(async () => slow.resolve({ success: true, data: ISSUES }));
		expect(screen.queryByText("Login fails")).not.toBeInTheDocument();

		// A failure that comes back late is dropped too.
		const failing = deferred<unknown>();
		api.getJiraIssues.mockImplementation(() => failing.promise);
		rerender(<JiraSidePanel projectId="p3" open onOpenChange={onOpenChange} />);
		await waitFor(() => expect(api.getJiraIssues).toHaveBeenCalledWith("p3", 100));
		rerender(<JiraSidePanel projectId="p3" open={false} onOpenChange={onOpenChange} />);
		await act(async () => failing.reject(new Error("late")));
		rerender(<JiraSidePanel projectId="p3" open onOpenChange={onOpenChange} />);
		expect(screen.queryByText("late")).not.toBeInTheDocument();
	});

	it("drops a connection answer for a project the panel has left", async () => {
		const slow = deferred<unknown>();
		api.checkJiraConnection.mockReturnValueOnce(slow.promise);
		const { rerender } = jira();
		rerender(<JiraSidePanel projectId="p1" open={false} onOpenChange={onOpenChange} />);
		await act(async () => slow.resolve({ success: false, error: "stale" }));
		const late = deferred<unknown>();
		api.checkJiraConnection.mockReturnValueOnce(late.promise);
		rerender(<JiraSidePanel projectId="p1" open onOpenChange={onOpenChange} />);
		rerender(<JiraSidePanel projectId="p1" open={false} onOpenChange={onOpenChange} />);
		await act(async () => late.reject(new Error("stale too")));
		rerender(<JiraSidePanel projectId="p1" open onOpenChange={onOpenChange} />);
		await screen.findByText("Login fails");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("JiraSidePanel: the list kept for five minutes", () => {
	it("shows a recent list without reading Jira again", async () => {
		localStorage.setItem("jira-workitems-cache-p1", JSON.stringify([issue("KEPT-1")]));
		localStorage.setItem("jira-workitems-cache-p1-time", String(Date.now() - 60_000));
		jira();
		expect(await screen.findByText("Issue KEPT-1")).toBeInTheDocument();
		await waitFor(() => expect(api.checkJiraConnection).toHaveBeenCalled());
		await wait(10);
		expect(api.getJiraIssues).not.toHaveBeenCalled();
	});

	it("reads Jira again for an old, broken or foreign list, and keeps the new one", async () => {
		const now = Date.now();
		for (const [data, time] of [
			[JSON.stringify([issue("OLD-1")]), String(now - 6 * 60_000)],
			["{not json", String(now)],
			[JSON.stringify({ not: "a list" }), String(now)],
			[JSON.stringify([issue("NO-TIME")]), null],
		] as const) {
			localStorage.clear();
			localStorage.setItem("jira-workitems-cache-p1", data);
			if (time) localStorage.setItem("jira-workitems-cache-p1-time", time);
			api.getJiraIssues.mockClear();
			jira();
			await screen.findByText("Login fails");
			expect(api.getJiraIssues).toHaveBeenCalledTimes(1);
			cleanup();
		}
		expect(JSON.parse(localStorage.getItem("jira-workitems-cache-p1") ?? "[]")).toHaveLength(3);
		expect(Number(localStorage.getItem("jira-workitems-cache-p1-time"))).toBeGreaterThanOrEqual(now);
	});

	it("still works when the storage refuses to read or write", async () => {
		vi.spyOn(localStorage, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(localStorage, "setItem").mockImplementation(() => {
			throw new Error("full");
		});
		await openJira();
		fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
		expect(panel()).toHaveStyle({ width: "320px" });
		fireEvent.click(screen.getByRole("button", { name: "Expand" }));
		expect(panel()).toHaveStyle({ width: "384px" });
	});
});

describe("JiraSidePanel: search, filters and selection", () => {
	it("searches the title, the key and the description", async () => {
		await openJira();
		const search = screen.getByLabelText("Search issues...");
		fireEvent.change(search, { target: { value: "EXPORT" } });
		expect(shownIds()).toEqual(["PROJ-2"]);
		fireEvent.change(search, { target: { value: "proj-3" } });
		expect(shownIds()).toEqual(["PROJ-3"]);
		fireEvent.change(search, { target: { value: "attachment" } });
		expect(shownIds()).toEqual(["PROJ-1"]);
		fireEvent.change(search, { target: { value: "nothing like it" } });
		expect(screen.getByText("No Jira issues found")).toBeInTheDocument();
		expect(screen.getByText("Try adjusting your filters")).toBeInTheDocument();
	});

	it("filters by type and by status, each offered once and sorted", async () => {
		await openJira();
		const type = screen.getByLabelText("Type") as HTMLSelectElement;
		const status = screen.getByLabelText("Status") as HTMLSelectElement;
		expect(Array.from(type.options).map((o) => o.text)).toEqual(["All Types", "Bug", "Custom", "Story"]);
		expect(Array.from(status.options).map((o) => o.text)).toEqual(["All Statuses", "In Progress", "To Do"]);
		fireEvent.change(type, { target: { value: "Bug" } });
		expect(shownIds()).toEqual(["PROJ-1"]);
		fireEvent.change(type, { target: { value: "all" } });
		fireEvent.change(status, { target: { value: "To Do" } });
		expect(shownIds()).toEqual(["PROJ-1", "PROJ-3"]);
		fireEvent.change(type, { target: { value: "Story" } });
		expect(screen.getByText("Try adjusting your filters")).toBeInTheDocument();
		fireEvent.change(status, { target: { value: "all" } });
		fireEvent.change(type, { target: { value: "all" } });
		expect(shownIds()).toHaveLength(3);
	});

	it("selects rows, all shown rows, or none, and lists the selection", async () => {
		await openJira();
		const all = screen.getByRole("checkbox", { name: "Select all" });
		expect(all).toHaveAttribute("aria-checked", "false");
		expect(screen.getByText("0 / 3 selected")).toBeInTheDocument();

		fireEvent.click(row("PROJ-1"));
		expect(row("PROJ-1")).toHaveAttribute("aria-pressed", "true");
		expect(all).toHaveAttribute("aria-checked", "mixed");
		expect(screen.getByText("1 / 3 selected")).toBeInTheDocument();
		expect(screen.getByText("Drag selected issues to a Kanban column to import")).toBeInTheDocument();
		expect(screen.getByText("1 item(s) selected")).toBeInTheDocument();

		fireEvent.click(all);
		expect(all).toHaveAttribute("aria-checked", "true");
		expect(screen.getByText("3 item(s) selected")).toBeInTheDocument();
		fireEvent.click(all);
		expect(all).toHaveAttribute("aria-checked", "false");
		expect(screen.queryByText(/item\(s\) selected/)).not.toBeInTheDocument();

		fireEvent.click(row("PROJ-2"));
		fireEvent.click(row("PROJ-2"));
		expect(row("PROJ-2")).toHaveAttribute("aria-pressed", "false");
	});

	it("counts the selection among the shown rows, and lists at most three", async () => {
		api.getJiraIssues.mockResolvedValue({
			success: true,
			data: [...ISSUES, issue("PROJ-4"), issue("PROJ-5")],
		});
		jira();
		await screen.findByText("Login fails");
		fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
		expect(screen.getByText("5 item(s) selected")).toBeInTheDocument();
		expect(screen.getByText("+2 more item(s)")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Search issues..."), { target: { value: "PROJ-4" } });
		expect(screen.getByText("1 / 1 selected")).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Select all" })).toHaveAttribute("aria-checked", "true");
	});

	it("reads Jira again on refresh, from an empty search, filter and selection", async () => {
		await openJira();
		fireEvent.click(row("PROJ-1"));
		fireEvent.change(screen.getByLabelText("Type"), { target: { value: "Bug" } });
		fireEvent.change(screen.getByLabelText("Status"), { target: { value: "To Do" } });
		fireEvent.change(screen.getByLabelText("Search issues..."), { target: { value: "login" } });
		const answer = deferred<unknown>();
		api.getJiraIssues.mockReturnValueOnce(answer.promise);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(api.getJiraIssues).toHaveBeenCalledTimes(2);
		expect(screen.getByLabelText("Search issues...")).toHaveValue("");
		expect(screen.getByLabelText("Type")).toHaveValue("all");
		expect(screen.getByLabelText("Status")).toHaveValue("all");
		await act(async () => answer.resolve({ success: true, data: [issue("NEW-1"), ...ISSUES] }));
		expect(screen.getByText("Issue NEW-1")).toBeInTheDocument();
		expect(screen.getByText("0 / 4 selected")).toBeInTheDocument();
	});

	it("spins the refresh button while refreshing", async () => {
		await openJira();
		const answer = deferred<unknown>();
		api.getJiraIssues.mockReturnValueOnce(answer.promise);
		const refresh = screen.getByRole("button", { name: "Refresh" });
		fireEvent.click(refresh);
		expect(refresh).toBeDisabled();
		expect(refresh.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
		expect(refresh.querySelector("svg")?.getAttribute("class")).toContain("text-primary");
		expect(panel().querySelector(".h-8.animate-spin")).not.toBeNull();
		await act(async () => answer.resolve({ success: true, data: ISSUES }));
		expect(refresh).toBeEnabled();
		expect(refresh.querySelector("svg")?.getAttribute("class")).not.toContain("animate-spin");
	});
});

describe("JiraSidePanel: an issue outside the list", () => {
	it("reads an issue by its key, and adds it to the list", async () => {
		await openJira();
		const found = deferred<unknown>();
		api.getJiraIssue.mockReturnValue(found.promise);
		fireEvent.change(screen.getByLabelText("Search issues..."), { target: { value: " proj-42 " } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledWith("p1", "PROJ-42"));
		expect(screen.getByText("Searching for issue…")).toBeInTheDocument();
		await act(async () => found.resolve({ success: true, data: issue("PROJ-42", { title: "Far away" }) }));
		expect(screen.getByText("Far away")).toBeInTheDocument();
		expect(api.getJiraIssue).toHaveBeenCalledTimes(1);
	});

	it("reads a bare number in the connected project", async () => {
		await openJira();
		api.getJiraIssue.mockResolvedValue({ success: true, data: issue("PROJ-7") });
		fireEvent.change(screen.getByLabelText("Search issues..."), { target: { value: "7" } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledWith("p1", "PROJ-7"));
		expect(await screen.findByText("Issue PROJ-7")).toBeInTheDocument();
	});

	it("reads nothing for a listed key, a word, or a number without a project", async () => {
		api.checkJiraConnection.mockResolvedValue({ success: true, data: { connected: true } });
		await openJira();
		const search = screen.getByLabelText("Search issues...");
		for (const value of ["proj-1", "login", "7", "   "]) {
			fireEvent.change(search, { target: { value } });
			await wait(450);
		}
		expect(api.getJiraIssue).not.toHaveBeenCalled();
	});

	it("leaves the list as it is when the issue is not found or Jira fails", async () => {
		await openJira();
		const search = screen.getByLabelText("Search issues...");
		api.getJiraIssue.mockResolvedValueOnce({ success: false, error: "404" });
		fireEvent.change(search, { target: { value: "PROJ-50" } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledTimes(1));
		await wait(10);
		expect(screen.getByText("No Jira issues found")).toBeInTheDocument();
		api.getJiraIssue.mockResolvedValueOnce({ success: true });
		fireEvent.change(search, { target: { value: "PROJ-51" } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledTimes(2));
		api.getJiraIssue.mockRejectedValueOnce(new Error("no access"));
		fireEvent.change(search, { target: { value: "PROJ-52" } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledTimes(3));
		await wait(10);
		expect(screen.queryByText("Searching for issue…")).not.toBeInTheDocument();
		expect(screen.getByText("No Jira issues found")).toBeInTheDocument();
	});

	it("drops the answer for a key no longer asked for, and keeps one copy of an issue", async () => {
		await openJira();
		const slow = deferred<unknown>();
		api.getJiraIssue.mockReturnValueOnce(slow.promise);
		const search = screen.getByLabelText("Search issues...");
		fireEvent.change(search, { target: { value: "PROJ-60" } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledTimes(1));
		fireEvent.change(search, { target: { value: "" } });
		await act(async () => slow.resolve({ success: true, data: issue("PROJ-60") }));
		expect(screen.queryByText("Issue PROJ-60")).not.toBeInTheDocument();

		const failing = deferred<unknown>();
		api.getJiraIssue.mockReturnValueOnce(failing.promise);
		fireEvent.change(search, { target: { value: "PROJ-61" } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledTimes(2));
		fireEvent.change(search, { target: { value: "" } });
		await act(async () => failing.reject(new Error("late")));

		// Jira answers with an issue that is already listed under another spelling.
		api.getJiraIssue.mockResolvedValueOnce({ success: true, data: ISSUES[0] });
		fireEvent.change(search, { target: { value: "PROJ-01" } });
		await waitFor(() => expect(api.getJiraIssue).toHaveBeenCalledTimes(3));
		fireEvent.change(search, { target: { value: "" } });
		expect(screen.getAllByText("Login fails")).toHaveLength(1);
	});
});

describe("JiraSidePanel: dragging to the board", () => {
	function dataTransfer() {
		return { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" };
	}

	it("drags one issue, with a ghost, and tells the board", async () => {
		await openJira();
		const started = vi.fn();
		const ended = vi.fn();
		document.addEventListener("jira-drag-start", started);
		document.addEventListener("jira-drag-end", ended);
		const transfer = dataTransfer();
		fireEvent.dragStart(row("PROJ-2"), { dataTransfer: transfer });
		const data = JSON.parse(transfer.setData.mock.calls[0][1]);
		expect(transfer.setData.mock.calls[0][0]).toBe("application/json");
		expect(data).toEqual({ type: "jira-workitems", workItems: [ISSUES[1]] });
		expect(transfer.effectAllowed).toBe("copy");
		const ghost = transfer.setDragImage.mock.calls[0][0] as HTMLElement;
		expect(document.body.contains(ghost)).toBe(true);
		expect(ghost.style.outline).toContain("2px solid");
		expect((started.mock.calls[0][0] as CustomEvent).detail).toEqual(data);
		expect(row("PROJ-2").className).toContain("cursor-grabbing");

		fireEvent.dragEnd(row("PROJ-2"));
		expect(document.body.contains(ghost)).toBe(false);
		expect(ended).toHaveBeenCalledTimes(1);
		expect(row("PROJ-2").className).not.toContain("cursor-grabbing");
		document.removeEventListener("jira-drag-start", started);
		document.removeEventListener("jira-drag-end", ended);
	});

	it("drags every selected issue from a selected row", async () => {
		await openJira();
		fireEvent.click(row("PROJ-1"));
		fireEvent.click(row("PROJ-3"));
		const transfer = dataTransfer();
		fireEvent.dragStart(row("PROJ-3"), { dataTransfer: transfer });
		expect(JSON.parse(transfer.setData.mock.calls[0][1]).workItems.map((i: JiraWorkItem) => i.id)).toEqual([
			"PROJ-1",
			"PROJ-3",
		]);
		fireEvent.dragEnd(row("PROJ-3"));
		fireEvent.dragEnd(row("PROJ-3"));
	});

	it("keeps a drag over the panel, or a drop on it, from reaching the board", async () => {
		await openJira();
		const board = vi.fn();
		document.addEventListener("dragover", board);
		document.addEventListener("drop", board);
		for (const type of ["dragover", "drop"]) {
			const event = new Event(type, { bubbles: true, cancelable: true });
			panel().querySelector("h2")?.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(true);
		}
		expect(board).not.toHaveBeenCalled();
		document.removeEventListener("dragover", board);
		document.removeEventListener("drop", board);
	});
});

describe("JiraSidePanel: size and closing", () => {
	it("closes on its button or a click outside, not inside it or a dialog", async () => {
		await openJira();
		fireEvent.mouseDown(panel());
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		dialog.append("Import?");
		document.body.append(dialog);
		fireEvent.mouseDown(dialog);
		fireEvent.mouseDown(dialog.firstChild as Node);
		expect(onOpenChange).not.toHaveBeenCalled();
		fireEvent.mouseDown(document.body);
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
		const text = document.createTextNode("outside");
		document.body.append(text);
		fireEvent.mouseDown(text);
		expect(onOpenChange).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onOpenChange).toHaveBeenCalledTimes(3);
		dialog.remove();
		text.remove();
	});

	it("takes the width saved for the project, when it is a width it can take", async () => {
		for (const [saved, width] of [
			["500", "500px"],
			["320", "320px"],
			["900", "384px"],
			["wide", "384px"],
		]) {
			localStorage.setItem("jira-panel-width-p1", saved);
			jira();
			await screen.findByText("Login fails");
			expect(panel()).toHaveStyle({ width });
			cleanup();
		}
	});

	it("collapses to the narrowest width and comes back to the saved one", async () => {
		await openJira();
		fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
		expect(panel()).toHaveStyle({ width: "320px" });
		expect(localStorage.getItem("jira-panel-width-p1")).toBe("384");
		fireEvent.click(screen.getByRole("button", { name: "Expand" }));
		expect(panel()).toHaveStyle({ width: "384px" });
		localStorage.removeItem("jira-panel-width-p1");
		fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
		localStorage.removeItem("jira-panel-width-p1");
		fireEvent.click(screen.getByRole("button", { name: "Expand" }));
		expect(panel()).toHaveStyle({ width: "384px" });
	});

	it("resizes by its left edge between the narrowest and widest widths, and saves the result", async () => {
		await openJira();
		const handle = screen.getByRole("button", { name: "Resize" });
		fireEvent.mouseDown(handle, { clientX: 1000 });
		fireEvent.mouseMove(document, { clientX: 900 });
		expect(panel()).toHaveStyle({ width: "484px" });
		fireEvent.mouseMove(document, { clientX: 0 });
		expect(panel()).toHaveStyle({ width: "800px" });
		fireEvent.mouseUp(document);
		expect(localStorage.getItem("jira-panel-width-p1")).toBe("800");
		fireEvent.mouseMove(document, { clientX: 500 });
		expect(panel()).toHaveStyle({ width: "800px" });

		// Down to the narrowest width it is collapsed, and that width is not saved.
		fireEvent.mouseDown(handle, { clientX: 1000 });
		fireEvent.mouseDown(handle, { clientX: 1000 });
		fireEvent.mouseMove(document, { clientX: 2000 });
		fireEvent.mouseUp(document);
		expect(panel()).toHaveStyle({ width: "320px" });
		expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
		expect(localStorage.getItem("jira-panel-width-p1")).toBe("800");
	});

	it("stops resizing when the panel goes away", async () => {
		const { unmount } = await openJira();
		const remove = vi.spyOn(document, "removeEventListener");
		fireEvent.mouseDown(screen.getByRole("button", { name: "Resize" }), { clientX: 1000 });
		unmount();
		expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(["mousemove", "mouseup"]));
	});

	it("keeps each project's width when the project changes", async () => {
		localStorage.setItem("jira-panel-width-p1", "500");
		localStorage.setItem("jira-panel-width-p2", "600");
		const { rerender } = await openJira();
		expect(panel()).toHaveStyle({ width: "500px" });
		rerender(<JiraSidePanel projectId="p2" open onOpenChange={onOpenChange} />);
		expect(panel()).toHaveStyle({ width: "600px" });
		expect(localStorage.getItem("jira-panel-width-p1")).toBe("500");
		expect(localStorage.getItem("jira-panel-width-p2")).toBe("600");
	});
});

describe("AzureDevOpsSidePanel", () => {
	function azure(props: Partial<Parameters<typeof AzureDevOpsSidePanel>[0]> = {}) {
		return render(<AzureDevOpsSidePanel projectId="p1" open onOpenChange={onOpenChange} {...props} />);
	}
	const azurePanel = () => screen.getByRole("region", { name: "Azure DevOps import panel" });

	it("lists the work items with their number, priority and repository", async () => {
		api.getAzureDevOpsWorkItems.mockResolvedValue({
			success: true,
			data: [
				workItem(12, { priority: 2, repository: "web-app", workItemType: "User Story" }),
				workItem(13, { workItemType: "Feature", priority: 0 }),
				workItem(14, { workItemType: "Epic" }),
				workItem(15, { workItemType: "Task" }),
				workItem(16, { workItemType: "Bug" }),
				workItem(17, { workItemType: "Issue" }),
			],
		});
		azure();
		expect(await screen.findByText("Item 12")).toBeInTheDocument();
		expect(api.getAzureDevOpsWorkItems).toHaveBeenCalledWith("p1", undefined, undefined, 1000);
		const first = row("#12");
		expect(within(first).getByText("P2")).toBeInTheDocument();
		expect(within(first).getByText("web-app")).toBeInTheDocument();
		expect(within(first).getByText("User Story").className).toContain("text-success");
		expect(within(row("#13")).getByText("P0")).toBeInTheDocument();
		expect(within(row("#13")).getByText("Feature").className).toContain("text-purple-500");
		expect(within(row("#14")).getByText("Epic").className).toContain("text-orange-500");
		expect(within(row("#15")).getByText("Task").className).toContain("text-blue-500");
		expect(within(row("#16")).getByText("Bug").className).toContain("text-destructive");
		expect(within(row("#17")).getByText("Issue").className).toContain("text-gray-500");
		expect(within(row("#14")).queryByText(/^P\d/)).not.toBeInTheDocument();
		expect(azurePanel()).toHaveTextContent("Repository: web-app");
		expect(screen.getByLabelText("Work Item Type")).toBeInTheDocument();
		expect(screen.getByLabelText("State")).toBeInTheDocument();
		expect(screen.getByText("0 of 6 selected")).toBeInTheDocument();
	});

	it("names the repository in the title, read once per project", async () => {
		const { rerender } = azure();
		expect(await screen.findByRole("heading", { name: "Import work items from web-app" })).toBeInTheDocument();
		expect(api.detectAzureDevOpsRepository).toHaveBeenCalledWith("p1");
		expect(azurePanel()).toHaveTextContent("Project: Fabrikam");
		expect(azurePanel()).not.toHaveTextContent("Repository:");
		fireEvent.change(screen.getByLabelText("Search work items..."), { target: { value: "x" } });
		await wait(10);
		expect(api.detectAzureDevOpsRepository).toHaveBeenCalledTimes(1);

		api.detectAzureDevOpsRepository.mockResolvedValue({ success: true, data: {} });
		rerender(<AzureDevOpsSidePanel projectId="p2" open onOpenChange={onOpenChange} />);
		await waitFor(() => expect(api.detectAzureDevOpsRepository).toHaveBeenCalledWith("p2"));
		expect(await screen.findByRole("heading", { name: "Import work items from Fabrikam" })).toBeInTheDocument();
	});

	it("falls back to the project name, then to the generic title", async () => {
		api.detectAzureDevOpsRepository.mockResolvedValueOnce({ success: false });
		azure();
		expect(await screen.findByRole("heading", { name: "Import work items from Fabrikam" })).toBeInTheDocument();
		cleanup();

		api.detectAzureDevOpsRepository.mockRejectedValueOnce(new Error("no git"));
		azure();
		expect(await screen.findByRole("heading", { name: "Import work items from Fabrikam" })).toBeInTheDocument();
		cleanup();

		api.checkAzureDevOpsConnection.mockResolvedValue({ success: true, data: { connected: true } });
		api.detectAzureDevOpsRepository.mockResolvedValue({ success: true });
		azure();
		await waitFor(() => expect(api.detectAzureDevOpsRepository).toHaveBeenCalled());
		expect(screen.getByRole("heading", { name: "Import Azure DevOps Work Items" })).toBeInTheDocument();
		expect(azurePanel()).not.toHaveTextContent("Project:");
	});

	it("drops a repository answer for a project the panel has left", async () => {
		const slow = deferred<unknown>();
		api.detectAzureDevOpsRepository.mockReturnValueOnce(slow.promise);
		const { rerender } = azure();
		await waitFor(() => expect(api.detectAzureDevOpsRepository).toHaveBeenCalledWith("p1"));
		api.detectAzureDevOpsRepository.mockResolvedValue({ success: false });
		rerender(<AzureDevOpsSidePanel projectId="p2" open onOpenChange={onOpenChange} />);
		await act(async () => slow.resolve({ success: true, data: { repository: "stale-repo" } }));
		expect(screen.queryByText(/stale-repo/)).not.toBeInTheDocument();
	});

	it("reads a work item by its number when it is not listed", async () => {
		api.getAzureDevOpsWorkItems.mockResolvedValue({ success: true, data: [workItem(12)] });
		api.getAzureDevOpsWorkItem.mockResolvedValue({ success: true, data: workItem(99, { title: "Far item" }) });
		azure();
		await screen.findByText("Item 12");
		const search = screen.getByLabelText("Search work items...");
		fireEvent.change(search, { target: { value: "12" } });
		fireEvent.change(search, { target: { value: "bug" } });
		await wait(450);
		expect(api.getAzureDevOpsWorkItem).not.toHaveBeenCalled();
		fireEvent.change(search, { target: { value: "99" } });
		await waitFor(() => expect(api.getAzureDevOpsWorkItem).toHaveBeenCalledWith("p1", 99));
		expect(await screen.findByText("Far item")).toBeInTheDocument();
	});

	it("says what failed in its own words", async () => {
		api.checkAzureDevOpsConnection.mockResolvedValueOnce({ success: true, data: { connected: false } });
		azure();
		expect(await screen.findByRole("alert")).toHaveTextContent("Azure DevOps not configured");
		cleanup();
		api.getAzureDevOpsWorkItems.mockResolvedValueOnce({ success: false });
		azure();
		expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load work items");
		cleanup();
		azure();
		expect(await screen.findByText("No work items found")).toBeInTheDocument();
	});

	it("drags its items as Azure DevOps work items and counts more than three in the app's words", async () => {
		const items = [workItem(1), workItem(2), workItem(3), workItem(4), workItem(5)];
		api.getAzureDevOpsWorkItems.mockResolvedValue({ success: true, data: items });
		const started = vi.fn();
		document.addEventListener("azure-devops-drag-start", started);
		azure();
		await screen.findByText("Item 1");
		fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
		expect(screen.getByText("+2 more item(s)")).toBeInTheDocument();
		const transfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" };
		fireEvent.dragStart(row("#1"), { dataTransfer: transfer });
		expect(JSON.parse(transfer.setData.mock.calls[0][1])).toEqual({ type: "azure-devops-workitems", workItems: items });
		expect(started).toHaveBeenCalledTimes(1);
		fireEvent.dragEnd(row("#1"));
		document.removeEventListener("azure-devops-drag-start", started);
		expect(rows()).toHaveLength(5);
	});
});
