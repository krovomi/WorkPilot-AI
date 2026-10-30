/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import type { AutomationsState } from "../../../../shared/types";

vi.mock("../../task-engine/EngineTrioPicker", () => ({
	EngineTrioPicker: ({ value }: { value: { provider: string } }) => <div data-testid="picker">{value.provider}</div>,
}));
vi.mock("../../../hooks/useConfiguredProviders", () => ({
	useConfiguredProviders: () => ({ providers: [], loading: false }),
}));
const loadTasks = vi.hoisted(() => vi.fn());
vi.mock("../../../stores/task-store", () => ({ loadTasks }));

import { AutomationsIntegration } from "./AutomationsIntegration";

const withRule: AutomationsState = {
	rules: [
		{
			id: "r-000000000001",
			name: "Labelled issues",
			enabled: true,
			trigger: { type: "issue_labeled", label: "workpilot" },
			draft: true,
			dailyCap: 3,
			createdAt: "2026-10-20T00:00:00.000Z",
		},
	],
	statuses: {
		"r-000000000001": {
			lastRunAt: "2026-10-26T09:00:00.000Z",
			createdToday: 1,
			deferred: 2,
			lastError: "github_not_connected",
			lastErrorDetail: "GitHub is not connected for this project",
		},
	},
	activity: [
		{
			at: "2026-10-26T09:00:00.000Z",
			ruleId: "r-000000000001",
			ruleName: "Labelled issues",
			outcome: "ignored",
			subject: "#3",
			reason: "label_predates_rule",
		},
	],
};

const api = {
	get: vi.fn(),
	save: vi.fn(),
	remove: vi.fn(),
	run: vi.fn(),
	onEvent: vi.fn(() => () => undefined),
};
Object.defineProperty(window, "electronAPI", { value: { automations: api }, writable: true });

describe("AutomationsIntegration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		api.get.mockResolvedValue({ success: true, data: withRule });
		api.save.mockResolvedValue({ success: true, data: withRule });
	});

	it("shows each rule with what it did, the cap and the failure", async () => {
		render(<AutomationsIntegration projectId="p1" />);
		expect(await screen.findByText("Labelled issues", { selector: "div" })).toBeInTheDocument();
		expect(screen.getByText(/Issue labelled “workpilot”/)).toBeInTheDocument();
		expect(screen.getByText(/1 card today \(at most 3\)/)).toBeInTheDocument();
		expect(screen.getByText(/2 events wait for tomorrow/)).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("GitHub is not connected for this project (Settings › GitHub)");
		expect(screen.getByText(/the label was there before the rule/)).toBeInTheDocument();
	});

	it("sends a new rule as a draft by default", async () => {
		api.get.mockResolvedValue({ success: true, data: { rules: [], statuses: {}, activity: [] } });
		render(<AutomationsIntegration projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bugs" } });
		fireEvent.change(screen.getByLabelText("Label"), { target: { value: "bug" } });
		fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
		await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
		expect(api.save).toHaveBeenCalledWith("p1", {
			name: "Bugs",
			enabled: true,
			trigger: { type: "issue_labeled", label: "bug" },
			draft: true,
			dailyCap: 3,
		});
	});

	it("says a card will start at once when drafts are turned off", async () => {
		api.get.mockResolvedValue({ success: true, data: { rules: [], statuses: {}, activity: [] } });
		render(<AutomationsIntegration projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
		expect(screen.getByText("The card waits in the backlog until you start it.")).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("Draft cards"));
		expect(screen.getByText("Each card starts its build as soon as it is created.")).toBeInTheDocument();
	});

	it("sends a PR rule without card settings, and shows its reviews", async () => {
		api.get.mockResolvedValue({ success: true, data: { rules: [], statuses: {}, activity: [] } });
		render(<AutomationsIntegration projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Others' PRs" } });
		fireEvent.change(screen.getByLabelText("When"), { target: { value: "pr_opened" } });
		// A review is no card: nothing to choose about one, and nothing posted.
		expect(screen.queryByLabelText("Card kind")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("Draft cards")).not.toBeInTheDocument();
		expect(screen.getByText(/The review is never posted/)).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Base branch"), { target: { value: "develop" } });
		fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
		await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
		expect(api.save).toHaveBeenCalledWith("p1", {
			name: "Others' PRs",
			enabled: true,
			trigger: { type: "pr_opened", base: "develop" },
			draft: true,
			dailyCap: 3,
		});
	});

	it("lists a PR rule with its reviews and why a PR was skipped", async () => {
		api.get.mockResolvedValue({
			success: true,
			data: {
				rules: [{ ...withRule.rules[0], name: "PRs", trigger: { type: "pr_opened" } }],
				statuses: { "r-000000000001": { createdToday: 2, deferred: 0 } },
				activity: [
					{ at: "2026-10-26T09:00:00.000Z", ruleId: "r-000000000001", ruleName: "PRs", outcome: "review_started", subject: "PR #9" },
					{ at: "2026-10-26T09:00:00.000Z", ruleId: "r-000000000001", ruleName: "PRs", outcome: "ignored", subject: "PR #8", reason: "own_pr" },
				],
			},
		});
		render(<AutomationsIntegration projectId="p1" />);
		expect(await screen.findByText(/PR opened into any branch/)).toBeInTheDocument();
		expect(screen.getByText(/reviews wait for you/)).toBeInTheDocument();
		expect(screen.getByText(/2 reviews today \(at most 3\)/)).toBeInTheDocument();
		expect(screen.getByText(/started the review of PR #9/)).toBeInTheDocument();
		expect(screen.getByText(/you opened this PR/)).toBeInTheDocument();
	});

	it("shows the main process's refusal", async () => {
		api.get.mockResolvedValue({ success: true, data: { rules: [], statuses: {}, activity: [] } });
		api.save.mockResolvedValue({ success: false, error: "The trigger needs a label" });
		render(<AutomationsIntegration projectId="p1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Add a rule" }));
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bugs" } });
		fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("The trigger needs a label");
		// The form stays open with what was typed.
		expect(screen.getByLabelText("Name")).toHaveValue("Bugs");
	});
});
