/**
 * @vitest-environment jsdom
 */
/**
 * The governance panel (#353, lot 2): read only, it shows what
 * workpilot.policy.yaml says (hours, files, token budget), why it is refused
 * when it is, the policy's last decisions, and exports the audit trail.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../../shared/i18n";
import type { GovernanceReport } from "../../../../shared/types/governance";
import { GovernancePolicyPanel } from "../GovernancePolicyPanel";

const getGovernanceReport = vi.fn();
const exportPolicyAudit = vi.fn();

const full: GovernanceReport = {
	governance: {
		source: "repository:workpilot.policy.yaml",
		schedule: {
			timezone: "Europe/Paris",
			allowedHours: ["08:00-19:00"],
			days: ["mon", "tue"],
			openNow: false,
			localTime: "2026-06-01T20:00:00+02:00",
		},
		files: { forbidden: ["**/migrations/**"], requiresReview: [] },
		budget: { maxTokensPerHour: 500000, maxTokensPerTask: null },
	},
	errors: [],
	sources: [{ layer: "repository", path: "/p/workpilot.policy.yaml", rules: 1 }],
	tokensLastHour: 1200,
	metrics: { blocked24h: 0, breakerTrips7d: 0 },
	events: [
		{
			id: "e1",
			at: "2026-06-01T18:00:00Z",
			user: "dev",
			task: "007-db",
			tool: "Write",
			targetKind: "file",
			target: "db/migrations/1.sql",
			decision: "deny",
			rules: ["files.forbidden:**/migrations/**"],
			reason: "refused",
			provider: "openai",
			model: "gpt-5",
		},
		{
			id: "e2",
			at: "2026-06-01T18:05:00Z",
			user: null,
			task: null,
			tool: null,
			targetKind: null,
			target: null,
			decision: "budget_exceeded",
			rules: [],
			reason: null,
			provider: null,
			model: null,
		},
	],
};

beforeEach(() => {
	getGovernanceReport.mockReset();
	exportPolicyAudit.mockReset();
	Object.assign(window, { electronAPI: { getGovernanceReport, exportPolicyAudit } });
});

describe("GovernancePolicyPanel", () => {
	it("shows the hours, the files, the budget and the decisions", async () => {
		getGovernanceReport.mockResolvedValue(full);
		render(<GovernancePolicyPanel projectPath="/p" />);
		expect(await screen.findByText("Closed now")).toBeInTheDocument();
		expect(getGovernanceReport).toHaveBeenCalledWith("/p");
		expect(screen.getByText("08:00-19:00 (Europe/Paris), mon, tue")).toBeInTheDocument();
		expect(screen.getByText("**/migrations/**")).toBeInTheDocument();
		expect(screen.getByText("1,200 of 500,000 tokens in the last hour")).toBeInTheDocument();
		expect(screen.getByText("Refused")).toBeInTheDocument();
		expect(screen.getByText("Budget reached")).toBeInTheDocument();
		expect(screen.getByText("Write · db/migrations/1.sql")).toBeInTheDocument();
		expect(screen.getByText("0 agent actions stopped in the last 24 h")).toBeInTheDocument();
		expect(screen.getByText("0 circuit-breaker trips in the last 7 days")).toBeInTheDocument();
	});

	it("shows the task budget, the loop limit, the breaker's trips and the counts", async () => {
		getGovernanceReport.mockResolvedValue({
			...full,
			governance: {
				...full.governance,
				budget: { maxTokensPerHour: null, maxTokensPerTask: 2000000 },
				loopDetection: { maxSameToolCall: 3 },
			},
			metrics: { blocked24h: 1, breakerTrips7d: 2 },
			events: [{ ...full.events[0], decision: "tool_loop", rules: [] }],
		});
		render(<GovernancePolicyPanel projectPath="/p" />);
		expect(await screen.findByText("At most 2,000,000 tokens per task")).toBeInTheDocument();
		expect(screen.queryByText(/in the last hour/)).not.toBeInTheDocument();
		expect(screen.getByText("Pauses an agent after 3 identical tool calls")).toBeInTheDocument();
		expect(screen.getByText("1 agent action stopped in the last 24 h")).toBeInTheDocument();
		expect(screen.getByText("2 circuit-breaker trips in the last 7 days")).toBeInTheDocument();
		expect(screen.getAllByText("Circuit breaker").length).toBeGreaterThan(1);
	});

	it("says when a section is not set", async () => {
		getGovernanceReport.mockResolvedValue({
			...full,
			governance: {
				source: "",
				schedule: { ...full.governance?.schedule, openNow: true },
				files: { forbidden: [], requiresReview: ["infra/**"] },
				budget: null,
			},
			events: [{ ...full.events[0], target: "x", tool: null }],
		});
		render(<GovernancePolicyPanel projectPath="/p" />);
		expect(await screen.findByText("Open now")).toBeInTheDocument();
		expect(screen.getByText("No file rule")).toBeInTheDocument();
		expect(screen.getByText("No token limit")).toBeInTheDocument();
		expect(screen.getByText("The app's own limit")).toBeInTheDocument();
		expect(screen.getByText("x")).toBeInTheDocument();
	});

	it("says a policy without schedule has any time", async () => {
		getGovernanceReport.mockResolvedValue({
			...full,
			governance: { ...full.governance, schedule: null },
			events: [],
		});
		render(<GovernancePolicyPanel projectPath="/p" />);
		expect(await screen.findByText("Any time")).toBeInTheDocument();
		expect(screen.getByText("The policy has not taken any decision yet.")).toBeInTheDocument();
	});

	it("says why the policy is refused", async () => {
		getGovernanceReport.mockResolvedValue({
			governance: null,
			errors: ["workpilot.policy.yaml: 'budget.max_tokens_per_hour' must be a whole number"],
			sources: [],
			tokensLastHour: 0,
			events: [],
		});
		render(<GovernancePolicyPanel projectPath="/p" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("is refused");
		expect(screen.getByText(/must be a whole number/)).toBeInTheDocument();
	});

	it("says when the file sets nothing", async () => {
		getGovernanceReport.mockResolvedValue({ governance: null, errors: [], sources: [], tokensLastHour: 0, events: [] });
		render(<GovernancePolicyPanel projectPath="/p" />);
		expect(await screen.findByText(/sets no hours, files or token budget/)).toBeInTheDocument();
	});

	it("says when the report cannot be read", async () => {
		getGovernanceReport.mockRejectedValueOnce(new Error("runner gone")).mockRejectedValueOnce("plain");
		render(<GovernancePolicyPanel projectPath="/p" />);
		expect(await screen.findByText(/runner gone/)).toBeInTheDocument();
		fireEvent.click(screen.getByText("Refresh"));
		expect(await screen.findByText(/could not be read: plain/)).toBeInTheDocument();
	});

	it("exports the audit trail and says where", async () => {
		getGovernanceReport.mockResolvedValue(full);
		exportPolicyAudit
			.mockResolvedValueOnce({ filePath: "/home/me/a.csv", count: 2 })
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("disk full"))
			.mockRejectedValueOnce("denied");
		render(<GovernancePolicyPanel projectPath="/p" />);
		await screen.findByText("Closed now");
		fireEvent.click(screen.getByText("Export CSV"));
		expect(await screen.findByText("2 decisions exported to /home/me/a.csv")).toBeInTheDocument();
		expect(exportPolicyAudit).toHaveBeenLastCalledWith("/p", "csv");
		fireEvent.click(screen.getByText("Export JSON"));
		await waitFor(() => expect(screen.queryByText(/exported to/)).not.toBeInTheDocument());
		expect(exportPolicyAudit).toHaveBeenLastCalledWith("/p", "json");
		fireEvent.click(screen.getByText("Export CSV"));
		expect(await screen.findByText("The export failed: disk full")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Export CSV"));
		expect(await screen.findByText("The export failed: denied")).toBeInTheDocument();
	});
});
