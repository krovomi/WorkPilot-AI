/** @vitest-environment jsdom */
/**
 * The hub: one tab per panel, and the open project's findings only. Opening
 * another project used to leave the previous one's scores on screen, and an
 * answer still in flight for it landed under the new project's name.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLongevityStore } from "../../../stores/phase35-stores";
import { Phase35Hub } from "../Phase35Hub";
import { type Api, deferred, openWorld } from "./phase35-world";

const REPORT = {
	project_path: "/work/a",
	score: 71.5,
	grade: "C" as const,
	penalties: {},
	bonuses: {},
	summary: { loc: 1200, total_debt_items: 3, by_kind: {} },
	projection: null,
	riskiest_files: [],
};

let api: Api;
beforeEach(async () => {
	api = await openWorld({
		listDomains: async () => ({ success: true, domains: [] }),
		getProjectDomain: async () => ({ success: true, domain: null, languages: [] }),
		scoreProjectAgentHealth: async () => ({ success: true, scores: [], pending: [], tasks_read: 0, min_runs: 3 }),
		listGenerations: async () => ({ success: true, details: [] }),
		detectGenTestCommands: async () => ({ success: true, commands: [] }),
	});
});
afterEach(cleanup);

const TABS: [string, string][] = [
	["Agent Health", "Agent Health"],
	["Adaptive Model Routing", "Adaptive Model Routing"],
	["Domain-Specific Agents", "Domain-Specific Agents"],
	["CI/CD Anomaly Detective", "CI/CD Anomaly Detective"],
	["License Governance", "License Governance"],
	["Architecture Drift Detection", "Architecture Drift Detection"],
	["Generational Tests", "Generational Tests"],
	["i18n Auto-Scaling", "i18n Auto-Scaling"],
	["Cognitive Context Optimizer", "Cognitive Context Optimizer"],
	["Audit Trail", "Audit Trail"],
	["Real-time Pair Programming", "Real-time Pair Programming"],
	["Codebase Longevity Score", "Codebase Longevity Score"],
];

describe("Phase35Hub", () => {
	it("opens on the longevity score and shows each panel from its tab", async () => {
		render(<Phase35Hub projectPath="/work/a" />);
		expect(screen.getByRole("heading", { name: "Codebase Longevity Score" })).toBeInTheDocument();
		expect(screen.getByText(/Twelve advanced tools in one place/)).toBeInTheDocument();
		for (const [tab, heading] of TABS) {
			fireEvent.click(screen.getByRole("tab", { name: tab }));
			expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
		}
	});

	it("has no project to work on when none is open", () => {
		render(<Phase35Hub />);
		expect(screen.getByText("No project path selected")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Compute score" })).toBeDisabled();
	});

	it("clears the previous project's findings and drops its late answer", async () => {
		const late = deferred<unknown>();
		api.scoreLongevity.mockImplementationOnce(async () => ({ success: true, report: REPORT }));
		const { rerender } = render(<Phase35Hub projectPath="/work/a" />);
		fireEvent.click(screen.getByRole("button", { name: "Compute score" }));
		expect(await screen.findByText("71.5")).toBeInTheDocument();

		rerender(<Phase35Hub projectPath="/work/b" />);
		expect(screen.queryByText("71.5")).not.toBeInTheDocument();
		expect(screen.getByText(/No data yet/)).toBeInTheDocument();

		// A score asked for B, then the project changes back before it answers.
		api.scoreLongevity.mockImplementationOnce(() => late.promise);
		fireEvent.click(screen.getByRole("button", { name: "Compute score" }));
		rerender(<Phase35Hub projectPath="/work/a" />);
		await act(async () => late.resolve({ success: true, report: { ...REPORT, score: 12 } }));
		expect(screen.queryByText("12.0")).not.toBeInTheDocument();
		expect(useLongevityStore.getState()).toMatchObject({ phase: "idle", report: null });
	});

	it("says so when the backend does not answer", async () => {
		render(<Phase35Hub projectPath="/work/a" />);
		fireEvent.click(screen.getByRole("button", { name: "Compute score" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Backend error: scoreLongevity is not answered");
	});

	it("keeps the findings when the same project's hub is opened again", async () => {
		api.scoreLongevity.mockImplementationOnce(async () => ({ success: true, report: REPORT }));
		const first = render(<Phase35Hub projectPath="/work/a" />);
		fireEvent.click(screen.getByRole("button", { name: "Compute score" }));
		await screen.findByText("71.5");
		first.unmount();
		render(<Phase35Hub projectPath="/work/a" />);
		expect(screen.getByText("71.5")).toBeInTheDocument();
	});

	it("starts what was typed afresh for the new project", async () => {
		const { rerender } = render(<Phase35Hub projectPath="/work/a" />);
		fireEvent.click(screen.getByRole("tab", { name: "Audit Trail" }));
		expect(screen.getByLabelText("Trail storage directory")).toHaveValue("/work/a/.workpilot/audit-trail");
		rerender(<Phase35Hub projectPath="/work/b" />);
		expect(screen.getByLabelText("Trail storage directory")).toHaveValue("/work/b/.workpilot/audit-trail");
	});
});
