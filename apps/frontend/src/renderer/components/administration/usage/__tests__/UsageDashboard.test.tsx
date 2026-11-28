/** @vitest-environment jsdom */
/**
 * The Usage tab's figures: each view drawn from what the server computed, the
 * period and filters sent with every question, a person's sheet (and its
 * erasure, for platform administrators), CSV exports, and a dormant account
 * deactivated by whoever manages members.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";
import { PersonSheet } from "../PersonSheet";
import { UsageDashboard } from "../UsageDashboard";
import { UsageTab } from "../../UsageTab";

const ended = (total: number, rate: number | null) => ({
	total,
	succeeded: total,
	failed: 0,
	cancelled: 0,
	success_rate: rate,
});

const SUMMARY = {
	start: "2026-10-29",
	end: "2026-11-27",
	tokens: { input: 1200, output: 300, cache_write: 0, cache_read: 0, total: 1500 },
	cost_usd: 250,
	sessions: 4,
	estimated: true,
	budget: { monthly_token_budget: 10_000, used_this_month: 1500, percent: 15 },
	active: { day: 2, week: 3, month: 5 },
	runs: ended(4, 0.75),
	jobs: ended(1, null),
};

const RICH: Record<string, unknown> = {
	summary: SUMMARY,
	daily: [
		{ day: "2026-11-26", provider: "anthropic", tokens: 1000, cost_usd: 2 },
		{ day: "2026-11-26", provider: "", tokens: 0, cost_usd: 0 },
		{ day: "2026-11-27", provider: "", tokens: 500, cost_usd: 1 },
	],
	people: [
		{
			user_id: "u1",
			name: "Ada",
			email: "ada@example.com",
			runs: 3,
			jobs: 1,
			tokens: 1400,
			cost_usd: 2.5,
			providers: ["anthropic"],
			models: ["claude-x"],
			last_seen_at: "2026-11-27T08:00:00Z",
		},
		{
			user_id: "u2",
			name: null,
			email: "bob@example.com",
			runs: 0,
			jobs: 0,
			tokens: 0,
			cost_usd: 0,
			providers: [],
			models: [],
			last_seen_at: null,
		},
		{
			user_id: null,
			name: null,
			email: null,
			runs: 1,
			jobs: 0,
			tokens: 100,
			cost_usd: 0.5,
			providers: [],
			models: [],
			last_seen_at: null,
		},
	],
	models: {
		models: [
			{ provider: "anthropic", model: "claude-x", sessions: 2, tokens: 1400, cost_usd: 2, runs: 2, succeeded: 2, failed: 0, success_rate: 1, cost_per_run_usd: 1 },
			{ provider: "openai", model: "gpt-x", sessions: 1, tokens: 100, cost_usd: 0.5, runs: 0, succeeded: 0, failed: 0, success_rate: null, cost_per_run_usd: null },
		],
		phases: [
			{ phase: "coding", provider: "anthropic", model: "claude-x", sessions: 2, tokens: 1400, cost_usd: 2, runs: 2, succeeded: 2, failed: 0, success_rate: 1, cost_per_run_usd: 1 },
			{ phase: "qa", provider: "openai", model: "gpt-x", sessions: 1, tokens: 100, cost_usd: 0.5, runs: 0, succeeded: 0, failed: 0, success_rate: null, cost_per_run_usd: null },
		],
	},
	projects: [
		{ project_id: "p1", name: "Shop", tokens: 1400, cost_usd: 2, runs: 2, phases: [{ phase: "coding", tokens: 1400, cost_usd: 2 }] },
		{ project_id: null, name: null, tokens: 100, cost_usd: 0.5, runs: 0, phases: [] },
	],
	pages: { enabled: true, pages: [{ client: "mobile", page: "home", opens: 3, people: 2 }] },
	delivery: {
		funnel: { invited: 4, accepted: 3, first_sign_in: 3, first_task: 2, first_merge: 1 },
		delivered: { tasks: 2, cost_usd: 3, cost_per_task_usd: 1.5, median_hours_to_merge: 6 },
		failures: [{ cause: "timeout", runs: 1, jobs: 0 }],
	},
	presence: {
		online: [{ user_id: "u1", name: "Ada", last_seen_at: "2026-11-27T08:00:00Z" }],
		running: [
			{ kind: "run", what: "coding", started_at: "2026-11-27T07:00:00Z", project: "Shop", user_id: "u1", name: "Ada" },
			{ kind: "job", what: "roadmap", started_at: "2026-11-27T07:30:00Z", project: null, user_id: null, name: null },
		],
		dormant: [
			{ user_id: "u2", name: null, email: "bob@example.com", last_seen_at: null },
			{ user_id: "u3", name: "Cy", email: "cy@example.com", last_seen_at: "2026-09-01T08:00:00Z" },
		],
		dormant_after_days: 30,
	},
};

const EMPTY: Record<string, unknown> = {
	summary: { ...SUMMARY, estimated: false, budget: null, cost_usd: 0 },
	daily: [],
	people: [],
	models: { models: [], phases: [] },
	projects: [],
	pages: { enabled: false, pages: [] },
	delivery: {
		funnel: { invited: 0, accepted: 0, first_sign_in: 0, first_task: 0, first_merge: 0 },
		delivered: { tasks: 0, cost_usd: 0, cost_per_task_usd: null, median_hours_to_merge: null },
		failures: [],
	},
	presence: { online: [], running: [], dormant: [], dormant_after_days: 30 },
};

const SHEET = {
	user: { user_id: "u1", name: "Ada", email: "ada@example.com" },
	summary: SUMMARY,
	daily: [],
	timeline: [
		{ at: "2026-11-27T08:00:00Z", kind: "sign_in", what: "auth.login.local" },
		{ at: "2026-11-27T07:00:00Z", kind: "run", what: "coding", status: "succeeded", project: "Shop", provider: "anthropic", model: "claude-x" },
	],
	pages: { enabled: true, pages: [] },
};

const serverUsage = {
	getUsageView: vi.fn(),
	getUsagePerson: vi.fn(),
	exportUsage: vi.fn(),
	eraseAccount: vi.fn(),
	getUsageSettings: vi.fn(),
};
let world = RICH;
const setUserActive = vi.fn(async () => true);

function grant(permissions: string[], platformAdmin = false): void {
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin: platformAdmin,
		orgId: "o1",
		organizations: [],
		permissions: new Set(permissions),
	});
}

function lastQuery(view: string) {
	const calls = serverUsage.getUsageView.mock.calls.filter(([v]) => v === view);
	return calls[calls.length - 1]?.[1];
}

beforeEach(() => {
	world = RICH;
	for (const fn of Object.values(serverUsage)) fn.mockReset();
	serverUsage.getUsageView.mockImplementation(async (view: string) => ({ ok: true, data: world[view] }));
	serverUsage.getUsagePerson.mockResolvedValue({ ok: true, data: SHEET });
	serverUsage.getUsageSettings.mockResolvedValue({ ok: false, error: "nope" });
	setUserActive.mockClear();
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverUsage };
	useAdminStore.setState({
		members: [
			{ user_id: "u1", email: "ada@example.com", display_name: "Ada", role_id: "r", role_slug: "member", role_name: "Member", is_active: true, created_at: "" },
			{ user_id: "u2", email: "bob@example.com", display_name: "", role_id: "r", role_slug: "member", role_name: "Member", is_active: true, created_at: "" },
		],
		groups: [{ id: "g1", name: "Team A", description: "", role_slug: null, role_name: null, members: [], projects: [], created_at: "" }],
		groupProjects: [{ id: "p1", name: "Shop" }],
		loadMembers: vi.fn(async () => undefined),
		loadGroups: vi.fn(async () => undefined),
		loadGroupProjects: vi.fn(async () => undefined),
		setUserActive,
	});
	grant(["usage.read", "org.member.write"]);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("UsageDashboard", () => {
	it("draws every view the server computed", async () => {
		render(<UsageDashboard />);
		expect(await screen.findByText("Partly estimated")).toBeInTheDocument();
		expect(screen.getByText("15 %")).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Tokens per day, by provider" })).toBeInTheDocument();
		expect(screen.getAllByText("Unknown provider").length).toBeGreaterThan(0);
		expect(screen.getByRole("button", { name: "bob@example.com" })).toBeInTheDocument();
		expect(screen.getAllByText("Erased account").length).toBeGreaterThan(0);
		expect(screen.getByText("No project")).toBeInTheDocument();
		expect(screen.getByText("Phone")).toBeInTheDocument();
		expect(screen.getByText("2 tasks merged")).toBeInTheDocument();
		expect(screen.getByText("Timed out")).toBeInTheDocument();
		expect(screen.getByText("1 person online")).toBeInTheDocument();
		expect(screen.getByText("2 runs in progress")).toBeInTheDocument();
		expect(screen.getByText("never signed in")).toBeInTheDocument();
		expect(lastQuery("summary")).toMatchObject({ platform: false });
	});

	it("says when a period holds nothing", async () => {
		world = EMPTY;
		render(<UsageDashboard />);
		expect(await screen.findByText("No budget set")).toBeInTheDocument();
		expect(screen.getByText("Page activity is off for this organization: nothing is counted.")).toBeInTheDocument();
		expect(screen.getAllByText("Nothing in this period.").length).toBeGreaterThan(5);
		expect(screen.getByText("0 people online")).toBeInTheDocument();
	});

	it("shows the server's refusal", async () => {
		serverUsage.getUsageView.mockResolvedValue({ ok: false, error: "Permission denied" });
		render(<UsageDashboard />);
		expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Permission denied");
	});

	it("sends the period and filters, and the platform for its administrators", async () => {
		grant(["usage.read"], true);
		render(<UsageDashboard />);
		await screen.findByText("Partly estimated");
		fireEvent.change(screen.getByLabelText("Period"), { target: { value: "7d" } });
		fireEvent.change(screen.getByLabelText("Person"), { target: { value: "u2" } });
		fireEvent.change(screen.getByLabelText("Group"), { target: { value: "g1" } });
		fireEvent.change(screen.getByLabelText("Project"), { target: { value: "p1" } });
		fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } });
		fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-x" } });
		await waitFor(() =>
			expect(lastQuery("summary")).toMatchObject({
				user_id: "u2",
				group_id: "g1",
				project_id: "p1",
				provider: "openai",
				model: "gpt-x",
			}),
		);
		const week = lastQuery("summary");
		expect(Date.parse(week.end) - Date.parse(week.start)).toBe(6 * 86_400_000);

		fireEvent.change(screen.getByLabelText("Period"), { target: { value: "custom" } });
		fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01" } });
		fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-10" } });
		await waitFor(() => expect(lastQuery("summary")).toMatchObject({ start: "2026-11-01", end: "2026-11-10" }));

		fireEvent.click(screen.getByLabelText("Whole platform"));
		await waitFor(() => expect(lastQuery("summary")).toMatchObject({ platform: true }));
		const platform = lastQuery("summary");
		expect(platform).not.toHaveProperty("user_id");
		expect(platform).not.toHaveProperty("group_id");
		expect(platform).toMatchObject({ provider: "openai", model: "gpt-x" });
		expect(screen.queryByLabelText("Person")).toBeNull();
		// Platform-wide, a dormant account is not the organization's to deactivate.
		expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
	});

	it("exports a table as CSV, or says why not", async () => {
		const create = vi.fn(() => "blob:csv");
		const revoke = vi.fn();
		Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
		serverUsage.exportUsage.mockResolvedValueOnce({ ok: true, data: "day,tokens\n" });
		render(<UsageDashboard />);
		await screen.findByText("Partly estimated");
		fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
		await waitFor(() => expect(click).toHaveBeenCalled());
		expect(serverUsage.exportUsage).toHaveBeenCalledWith("daily", expect.objectContaining({ platform: false }));
		expect(revoke).toHaveBeenCalledWith("blob:csv");

		serverUsage.exportUsage.mockResolvedValueOnce({ ok: false, error: "Not allowed" });
		fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[1]);
		expect(await screen.findByText("The server refused: Not allowed")).toBeInTheDocument();
	});

	it("deactivates a dormant account and reads presence again", async () => {
		render(<UsageDashboard />);
		await screen.findByText("never signed in");
		const before = serverUsage.getUsageView.mock.calls.filter(([v]) => v === "presence").length;
		fireEvent.click(screen.getAllByRole("button", { name: "Deactivate" })[0]);
		expect(setUserActive).toHaveBeenCalledWith("u2", false);
		await waitFor(() =>
			expect(serverUsage.getUsageView.mock.calls.filter(([v]) => v === "presence").length).toBe(before + 1),
		);
		setUserActive.mockResolvedValueOnce(false);
		fireEvent.click(screen.getAllByRole("button", { name: "Deactivate" })[1]);
		expect(setUserActive).toHaveBeenLastCalledWith("u3", false);
	});

	it("offers no deactivation without the right to manage members", async () => {
		grant(["usage.read"]);
		render(<UsageDashboard />);
		await screen.findByText("never signed in");
		expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
	});

	it("opens a person's sheet and comes back", async () => {
		render(<UsageDashboard />);
		fireEvent.click((await screen.findAllByRole("button", { name: "Ada" }))[0]);
		expect(await screen.findByText("auth.login.local")).toBeInTheDocument();
		expect(screen.getByText("Sign-in")).toBeInTheDocument();
		expect(screen.getByText("succeeded")).toBeInTheDocument();
		expect(serverUsage.getUsagePerson).toHaveBeenCalledWith("u1", expect.objectContaining({ platform: false }));
		// Only a platform administrator erases an account.
		expect(screen.queryByRole("button", { name: "Erase the account" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Back to the figures" }));
		expect(await screen.findByText("Partly estimated")).toBeInTheDocument();
	});

	it("opens a sheet from the presence lists, and shows a refusal", async () => {
		serverUsage.getUsagePerson.mockResolvedValue({ ok: false, error: "User not found" });
		render(<UsageDashboard />);
		await screen.findByText("never signed in");
		const presence = screen.getByText("Right now").closest("section") as HTMLElement;
		fireEvent.click(within(presence).getByRole("button", { name: "u2" }));
		expect(await screen.findByText("The server refused: User not found")).toBeInTheDocument();
	});

	it("lets a platform administrator erase an account once its address is typed", async () => {
		grant(["usage.read"], true);
		const sheet = { ...SHEET, user: { user_id: "u1", name: null, email: null }, timeline: [] };
		serverUsage.getUsagePerson.mockResolvedValue({ ok: true, data: sheet });
		serverUsage.eraseAccount.mockResolvedValueOnce({ ok: false, error: "The address does not match the account" });
		render(<UsageDashboard />);
		fireEvent.click((await screen.findAllByRole("button", { name: "Ada" }))[0]);
		const erase = await screen.findByRole("button", { name: "Erase the account" });
		expect(erase).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Type the account's email address"), {
			target: { value: "ada@example.com" },
		});
		fireEvent.click(erase);
		expect(await screen.findByText("The server refused: The address does not match the account")).toBeInTheDocument();
		serverUsage.eraseAccount.mockResolvedValueOnce({ ok: true, data: { erased: true } });
		fireEvent.click(erase);
		expect(await screen.findByText(/The account was erased/)).toBeInTheDocument();
		expect(serverUsage.eraseAccount).toHaveBeenLastCalledWith("u1", "ada@example.com");
	});

	it("waits without a bridge", () => {
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		render(<UsageDashboard />);
		expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
		fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
		fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
	});

	it("drops an answer that arrives after the view is gone", async () => {
		let answer: (value: unknown) => void = () => undefined;
		serverUsage.getUsageView.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		serverUsage.getUsagePerson.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const { unmount } = render(<UsageDashboard />);
		unmount();
		answer({ ok: true, data: SUMMARY });
		await Promise.resolve();
	});
});

describe("PersonSheet", () => {
	it("waits without a bridge, and erases nothing once it is gone", async () => {
		grant(["usage.read"], true);
		const { unmount } = render(<PersonSheet personId="u1" query={{}} onBack={vi.fn()} />);
		await screen.findByText("auth.login.local");
		(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
		fireEvent.change(screen.getByLabelText("Type the account's email address"), {
			target: { value: "ada@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Erase the account" }));
		expect(serverUsage.eraseAccount).not.toHaveBeenCalled();
		unmount();
		render(<PersonSheet personId="u1" query={{}} onBack={vi.fn()} />);
		expect(screen.getByText("Loading…")).toBeInTheDocument();
	});

	it("drops a sheet that arrives once it is closed", async () => {
		let answer: (value: unknown) => void = () => undefined;
		serverUsage.getUsagePerson.mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const { unmount } = render(<PersonSheet personId="u1" query={{}} onBack={vi.fn()} />);
		unmount();
		answer({ ok: true, data: SHEET });
		await Promise.resolve();
	});
});

describe("UsageTab", () => {
	it("switches between the figures and the collection settings", async () => {
		render(<UsageTab />);
		expect(await screen.findByText("Partly estimated")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("tab", { name: "Collection and retention" }));
		expect(await screen.findByText("The server refused: nope")).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: "Collection and retention" })).toHaveAttribute("aria-selected", "true");
	});
});
