/**
 * @vitest-environment jsdom
 */
/**
 * The rehearsal report shows the verdict, each subtask with its findings in the
 * user's language, the API mocks, and the files the plan would touch.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SimulationResult } from "../../../../shared/types/sandbox";
import { PlanRehearsalReport } from "../PlanRehearsalReport";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "path" in options ? `${key}:${String(options.path)}` : key,
		i18n: { language: "en" },
	}),
}));

const RESULT: SimulationResult = {
	id: "r1",
	specId: "001-orders",
	mode: "plan",
	baseRef: "develop",
	phase: "complete",
	steps: [
		{
			index: 1,
			subtaskId: "1.1",
			phase: "Orders",
			description: "Add the route",
			status: "error",
			durationMs: 1,
			tokensUsed: 0,
			mockApiCalls: [
				{ url: "/orders/1", method: "GET", statusCode: 200, body: '{"id":"x"}', strategy: "schema_based" },
			],
			warnings: [],
			errors: ["src/routes.cs is modified but exists neither in develop nor in an earlier subtask."],
			findings: [
				{
					level: "error",
					code: "file_missing",
					params: { path: "src/routes.cs", ref: "develop" },
					message: "src/routes.cs is modified but exists neither in develop nor in an earlier subtask.",
				},
			],
		},
	],
	diffs: [{ filePath: "src/routes.cs", changeType: "modified", additions: 0, deletions: 0, hunks: [] }],
	planFindings: [],
	contracts: ["openapi.yaml"],
	partial: false,
	totalTokensUsed: 0,
	estimatedCostUsd: 0,
	estimatedRealCostUsd: 1.5,
	costEstimate: { spec_id: "001-orders", total_cost_usd: 1.5, confidence: "medium", phases: [], warnings: [] },
	durationMs: 5,
	successCount: 0,
	warningCount: 0,
	errorCount: 1,
	verdict: "blocked",
	createdAt: "2026-11-09T00:00:00Z",
};

describe("PlanRehearsalReport", () => {
	it("shows the verdict, the translated findings, the mocks and the footprint", () => {
		render(<PlanRehearsalReport result={RESULT} />);
		expect(screen.getByRole("status").textContent).toContain("verdict.blocked");
		expect(screen.getByText("findings.file_missing:src/routes.cs")).toBeTruthy();
		expect(screen.getByText("GET /orders/1 → 200")).toBeTruthy();
		expect(screen.getByText('{"id":"x"}')).toBeTruthy();
		expect(screen.getByText("src/routes.cs")).toBeTruthy();
		expect(screen.getByText("openapi.yaml")).toBeTruthy();
		expect(screen.getByText("$1.50")).toBeTruthy();
	});

	it("says when no contract backs the mocks", () => {
		render(<PlanRehearsalReport result={{ ...RESULT, contracts: [], costEstimate: null }} />);
		expect(screen.getByText("plan.noContracts")).toBeTruthy();
		expect(screen.getByText("plan.unknown")).toBeTruthy();
	});
});
