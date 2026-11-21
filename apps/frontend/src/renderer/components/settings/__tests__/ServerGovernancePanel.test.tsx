/**
 * @vitest-environment jsdom
 */
/**
 * The governance of a server project (#353, lot 4): read from the server by
 * project id, the calls its agents wait on answered there, its kill switch;
 * each button only where the server says the person may act. The Guardrails
 * page shows it instead of the rules editor for a server project.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import "../../../../shared/i18n";
import type { Project } from "../../../../shared/types";
import type { ServerGovernanceReport } from "../../../../shared/types/governance";
import { useProjectStore } from "../../../stores/project-store";
import { GuardrailsSettings, GuardrailsView } from "../GuardrailsSettings";
import { ServerGovernancePanel } from "../ServerGovernancePanel";

const api = {
	getServerGovernance: vi.fn(),
	answerServerGovernanceRequest: vi.fn(),
	stopServerProjectAgents: vi.fn(),
	exportServerPolicyAudit: vi.fn(),
};

const report: ServerGovernanceReport = {
	governance: {
		source: "workpilot.policy.yaml",
		schedule: null,
		files: { forbidden: [], requiresReview: ["infra/**"], reviewers: ["security"] },
		budget: null,
	},
	errors: [],
	sources: [],
	tokensLastHour: 0,
	metrics: { blocked24h: 1, breakerTrips7d: 0 },
	events: [
		{
			id: "e1",
			at: "2026-11-20T10:00:00Z",
			user: null,
			task: "001-a",
			tool: "Write",
			targetKind: "file",
			target: "infra/main.tf",
			decision: "approved",
			rules: ["files.requires_review:infra/**"],
			reason: null,
			provider: null,
			model: null,
			approvedBy: "Ada <u-1> [security]",
		},
	],
	pending: [
		{
			id: "0123456789ab",
			at: "2026-11-20T10:05:00Z",
			rules: ["files.requires_review:infra/**"],
			tool: "Write",
			targetKind: "file",
			target: "infra/net.tf",
			task: "002-b",
			message: null,
		},
	],
	agents: { mine: 1, project: 3 },
	may: { approve: true, stop: true, stopProject: true, export: true },
};

beforeEach(() => {
	for (const mock of Object.values(api)) mock.mockReset();
	api.getServerGovernance.mockResolvedValue({ success: true, data: report });
	Object.assign(window, { electronAPI: api });
});

describe("ServerGovernancePanel", () => {
	it("shows the policy, who approves, the waiting calls and the decisions", async () => {
		render(<ServerGovernancePanel projectId="p-1" />);
		expect(await screen.findByText("infra/net.tf", { exact: false })).toBeInTheDocument();
		expect(api.getServerGovernance).toHaveBeenCalledWith("p-1");
		expect(screen.getByTestId("governance-approver")).toHaveTextContent("security");
		expect(screen.getByText("approved by Ada <u-1> [security]")).toBeInTheDocument();
		expect(screen.getByText("Agents running on the server: 1 yours, 3 in all")).toBeInTheDocument();
		expect(screen.getByText("1 call waiting for an approval")).toBeInTheDocument();
	});

	it("approves and refuses as the person signed in, then reads again", async () => {
		api.answerServerGovernanceRequest.mockResolvedValueOnce({ success: true, data: { decision: "approved" } });
		render(<ServerGovernancePanel projectId="p-1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Approved in your name");
		expect(api.answerServerGovernanceRequest).toHaveBeenCalledWith("p-1", "0123456789ab", true);
		expect(api.getServerGovernance).toHaveBeenCalledTimes(2);

		api.answerServerGovernanceRequest.mockResolvedValueOnce({ success: false, error: "asks one of these roles" });
		fireEvent.click(screen.getByRole("button", { name: "Refuse" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("asks one of these roles");
		expect(api.answerServerGovernanceRequest).toHaveBeenLastCalledWith("p-1", "0123456789ab", false);
	});

	it("stops the person's agents, and everyone's only after a confirmation", async () => {
		api.stopServerProjectAgents.mockResolvedValue({ success: true, data: { stoppedRuns: 2, stoppedJobs: 1 } });
		render(<ServerGovernancePanel projectId="p-1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Stop my agents" }));
		expect(await screen.findByRole("status")).toHaveTextContent("3 agents stopped");
		expect(api.stopServerProjectAgents).toHaveBeenCalledWith("p-1", "mine");

		fireEvent.click(screen.getByRole("button", { name: "Stop every agent of the project" }));
		expect(api.stopServerProjectAgents).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: /Confirm: stop 3 agents/ }));
		await waitFor(() => expect(api.stopServerProjectAgents).toHaveBeenLastCalledWith("p-1", "project"));

		api.stopServerProjectAgents.mockResolvedValueOnce({ success: false, error: "its owner's" });
		fireEvent.click(screen.getByRole("button", { name: "Stop my agents" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("its owner's");
	});

	it("exports the server's trail, and says when it cannot", async () => {
		api.exportServerPolicyAudit
			.mockResolvedValueOnce({ success: true, data: { filePath: "/home/me/a.csv", count: 4 } })
			.mockResolvedValueOnce({ success: true, data: null })
			.mockResolvedValueOnce({ success: false, error: "Missing permission: audit.export" });
		render(<ServerGovernancePanel projectId="p-1" />);
		fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
		expect(await screen.findByRole("status")).toHaveTextContent("4 decisions exported to /home/me/a.csv");
		expect(api.exportServerPolicyAudit).toHaveBeenCalledWith("p-1", "csv");
		fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
		await waitFor(() => expect(api.exportServerPolicyAudit).toHaveBeenCalledTimes(2));
		fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Missing permission: audit.export");
	});

	it("offers no action the server does not allow", async () => {
		api.getServerGovernance.mockResolvedValue({
			success: true,
			data: {
				...report,
				governance: { ...report.governance, files: { forbidden: [], requiresReview: ["infra/**"] } },
				may: { approve: false, stop: false, stopProject: false, export: false },
			},
		});
		render(<ServerGovernancePanel projectId="p-1" />);
		expect(await screen.findByText("1 call waiting for an approval")).toBeInTheDocument();
		expect(screen.getByTestId("governance-approver")).toHaveTextContent("Any member of the project");
		for (const name of ["Approve", "Refuse", "Stop my agents", "Stop every agent of the project", "Export CSV"]) {
			expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
		}
	});

	it("says when the server cannot be read", async () => {
		api.getServerGovernance.mockResolvedValue({ success: false, error: "Missing permission: audit.read" });
		render(<ServerGovernancePanel projectId="p-1" />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Missing permission: audit.read");
		api.getServerGovernance.mockResolvedValue({ success: false });
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(api.getServerGovernance).toHaveBeenCalledTimes(2));
	});
});

describe("the Guardrails page of a server project", () => {
	const serverProject = {
		id: "p-1",
		name: "Shop",
		path: "/mirror/p-1",
		remote: { repoUrl: "https://x/r.git", defaultBranch: "main", role: "member" },
	} as unknown as Project;

	beforeEach(() => {
		useProjectStore.setState({ projects: [serverProject], activeProjectId: "p-1" } as never);
	});

	it("shows the server's governance, not the rules editor of the mirror", async () => {
		render(<GuardrailsView />);
		expect(await screen.findByTestId("server-governance-panel")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Add rule" })).not.toBeInTheDocument();
		expect(api.getServerGovernance).toHaveBeenCalledWith("p-1");
	});

	it("does the same inside the settings dialog", async () => {
		render(<GuardrailsSettings />);
		expect(await screen.findByTestId("server-governance-panel")).toBeInTheDocument();
	});
});
