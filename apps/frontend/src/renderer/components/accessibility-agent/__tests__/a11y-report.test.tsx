/**
 * The accessibility page's new parts (#391): the score and its criteria, the
 * notes on a violation, and fixes ticked then made on a review branch.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { A11yReport, A11yViolation } from "../../../../shared/types/accessibility";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options && "count" in options ? `${key}:${options.count}` : key,
		i18n: { language: "fr-FR" },
	}),
}));

import { useAccessibilityStore } from "../../../stores/accessibility-store";
import { A11yFixBar } from "../A11yFixBar";
import { A11yScoreSection } from "../A11yScoreSection";
import { A11yViolationCard } from "../A11yViolationCard";

const violation = (over: Partial<A11yViolation> = {}): A11yViolation => ({
	ruleId: "img-alt",
	description: "Image without a text alternative",
	severity: "critical",
	wcagLevel: "A",
	wcagCriteria: "1.1.1",
	file: "src/App.tsx",
	line: 4,
	element: '<img src="/hero.png" />',
	suggestion: "Add alt",
	fixId: "img-alt:src/App.tsx:4:1",
	fix: { attribute: "alt", value: "Hero" },
	...over,
});

const report: A11yReport = {
	filesScanned: 4,
	targetLevel: "AA",
	violations: [violation(), violation({ ruleId: "heading-order", fixId: "", fix: null, line: 9 })],
	passedRules: [],
	summary: "",
	score: 72,
	criteria: [{ criterion: "1.1.1", name: "Non-text content", level: "A", count: 1, score: 80 }],
	pages: [{ file: "src/App.tsx", count: 2, score: 60 }],
	pagesWithoutLang: ["index.html"],
	history: [
		{ at: "2026-11-08T10:00:00+00:00", score: 60, targetLevel: "AA", violations: 4, filesScanned: 4 },
		{ at: "2026-11-09T10:00:00+00:00", score: 72, targetLevel: "AA", violations: 2, filesScanned: 4 },
	],
};

describe("A11yScoreSection", () => {
	it("shows the score, its trend, the criteria, the pages and the missing languages", () => {
		render(<A11yScoreSection report={report} />);
		expect(screen.getByText("72")).toBeTruthy();
		expect(screen.getByText("score.trendUp:2")).toBeTruthy();
		expect(screen.getByText("criteria.1.1.1")).toBeTruthy();
		expect(screen.getByText("src/App.tsx")).toBeTruthy();
		expect(screen.getByText("score.noLang:1")).toBeTruthy();
	});

	it("is absent for a report from before the score existed", () => {
		const { container } = render(<A11yScoreSection report={{ ...report, score: undefined }} />);
		expect(container.innerHTML).toBe("");
	});
});

describe("A11yViolationCard", () => {
	it("says when a violation is conditional, external or found in the running app", () => {
		render(<A11yViolationCard violation={violation({ conditional: true, external: true, dynamic: true, line: 0 })} />);
		expect(screen.getByText("notes.conditional")).toBeTruthy();
		expect(screen.getByText("notes.external")).toBeTruthy();
		expect(screen.getByText("notes.dynamic")).toBeTruthy();
		expect(screen.getByText("src/App.tsx")).toBeTruthy();
	});
});

describe("A11yFixBar", () => {
	const fix = vi.fn();

	beforeEach(() => {
		fix.mockReset();
		fix.mockResolvedValue({ applied: [{ fixId: "x" }], missing: [], review: { branch: "workpilot/003" }, aiAlt: 0 });
		(globalThis as unknown as { electronAPI: unknown }).electronAPI = { fixAccessibilityViolations: fix };
		useAccessibilityStore.setState({ selectedFixes: [], fixOutcome: null, fixError: null, fixing: false });
	});

	it("makes the ticked fixes on a review branch, in the page's language", async () => {
		render(<A11yFixBar report={report} projectPath="/p" local />);
		expect(screen.getByText("fix.available:1")).toBeTruthy();
		fireEvent.click(screen.getByText("fix.selectAll"));
		fireEvent.click(screen.getByText("fix.apply:1"));
		await screen.findByText("fix.done:1");
		expect(fix).toHaveBeenCalledWith({
			projectPath: "/p",
			fixIds: ["img-alt:src/App.tsx:4:1"],
			pageLang: "fr",
			aiAlt: false,
		});
	});

	it("cannot fix a server project from this computer", () => {
		render(<A11yFixBar report={report} projectPath="/p" local={false} />);
		fireEvent.click(screen.getByText("fix.selectAll"));
		expect((screen.getByText("fix.apply:1").closest("button") as HTMLButtonElement).disabled).toBe(true);
	});
});
