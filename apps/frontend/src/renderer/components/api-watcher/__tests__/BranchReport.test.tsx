/**
 * The comparison with the target branch on the API Watcher page (#389):
 * each contract, its changes, who uses what broke, and the CI workflow.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContractCompareReport } from "../../../../shared/types/api-watcher";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "more" in options ? `${key}:${options.first}+${options.more}` : key,
		i18n: { language: "en" },
	}),
}));

import { BranchReport } from "../BranchReport";

const REPORT: ContractCompareReport = {
	status: "breaking",
	base: "746625d5fd03e50e00857abe",
	target: "develop",
	unchecked: "",
	checkedAt: "2026-11-09T19:47:23+00:00",
	breakingCount: 2,
	potentiallyBreakingCount: 0,
	nonBreakingCount: 1,
	unacknowledgedBreakingCount: 1,
	registry: { source: ".workpilot/api-consumers.yaml", consumers: 1, errors: [] },
	contracts: [
		{
			path: "services/orders/api/openapi.yaml",
			format: "openapi",
			status: "changed",
			oldVersion: "1",
			newVersion: "2",
			breakingCount: 2,
			potentiallyBreakingCount: 0,
			nonBreakingCount: 1,
			unacknowledgedBreakingCount: 1,
			linesAdded: 0,
			linesRemoved: 0,
			changes: [
				{
					changeType: "endpoint_removed",
					category: "breaking",
					path: "POST /orders",
					description: "Endpoint POST /orders was removed",
					acknowledged: false,
					consumers: [
						{ name: "Web shop", contact: "@acme/web", files: ["apps/web/a.ts", "apps/web/b.ts"] },
					],
				},
				{
					changeType: "endpoint_removed",
					category: "breaking",
					path: "GET /legacy",
					description: "Endpoint GET /legacy was removed",
					acknowledged: true,
				},
			],
		},
		{
			path: "contracts/legacy.wsdl",
			format: "wsdl",
			status: "unsupported",
			oldVersion: "",
			newVersion: "",
			breakingCount: 0,
			potentiallyBreakingCount: 0,
			nonBreakingCount: 0,
			unacknowledgedBreakingCount: 0,
			linesAdded: 3,
			linesRemoved: 1,
			changes: [],
		},
	],
};

describe("BranchReport", () => {
	it("shows each contract, its consumers and what is acknowledged", () => {
		render(<BranchReport report={REPORT} guide="## guide" ciWorkflow="name: API contract" />);
		expect(screen.getByText("services/orders/api/openapi.yaml")).toBeInTheDocument();
		expect(screen.getByText("Web shop")).toBeInTheDocument();
		expect(screen.getByText("@acme/web")).toBeInTheDocument();
		expect(screen.getByText("branch.files:apps/web/a.ts+1")).toBeInTheDocument();
		expect(screen.getAllByText("branch.acknowledged")).toHaveLength(1);
		expect(screen.getByText("branch.unsupported")).toBeInTheDocument();
		expect(screen.getByTestId("api-ci-workflow")).toHaveTextContent("name: API contract");
	});

	it("says why nothing was compared", () => {
		render(
			<BranchReport
				report={{ ...REPORT, status: "unchecked", unchecked: "not a git repository", contracts: [] }}
				guide=""
			/>,
		);
		expect(screen.getByText("branch.unchecked")).toBeInTheDocument();
		expect(screen.queryByTestId("api-ci-workflow")).toBeNull();
	});
});
