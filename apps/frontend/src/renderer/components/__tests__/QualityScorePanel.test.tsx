/**
 * The code quality panel of a PR review: the score, the verdict, the issues
 * counted by severity and listed by category.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { QualityIssue, QualityScore } from "../../../preload/api/modules/quality-api";
import i18n from "../../../shared/i18n";
import { QualityScorePanel } from "../QualityScorePanel";
import { TooltipProvider } from "../ui/tooltip";

function issue(n: number, extra: Partial<QualityIssue> = {}): QualityIssue {
	return {
		category: "bugs",
		severity: "low",
		title: `Issue ${n}`,
		description: "d",
		file: `src/file${n}.ts`,
		line: null,
		suggestion: null,
		...extra,
	};
}

function score(issues: QualityIssue[], extra: Partial<QualityScore> = {}): QualityScore {
	return {
		overall_score: 72.46,
		grade: "B",
		total_issues: issues.length,
		critical_issues: issues.filter((i) => i.severity === "critical").length,
		is_passing: true,
		issues,
		...extra,
	};
}

function renderPanel(value: QualityScore) {
	return render(
		<TooltipProvider>
			<QualityScorePanel score={value} />
		</TooltipProvider>,
	);
}

describe("QualityScorePanel", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
	});

	it("celebrates a passing score without issues", () => {
		renderPanel(score([], { overall_score: 98 }));
		expect(screen.getByText(/Code Quality Analysis/)).toBeInTheDocument();
		expect(screen.getByText("Score: 98.0/100")).toBeInTheDocument();
		expect(screen.getByText(/PASSED/)).toBeInTheDocument();
		expect(screen.getByText("No issues detected! Great job!")).toBeInTheDocument();
		expect(screen.queryByText(/Issues? Detected/)).toBeNull();
	});

	it("says a failing score failed, with one issue counted in the singular", () => {
		renderPanel(score([issue(1, { severity: "critical", category: "security" })], { is_passing: false }));
		expect(screen.getByText(/FAILED/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "1 Issue Detected" })).toBeInTheDocument();
		expect(screen.getByText("1 Critical")).toBeInTheDocument();
		expect(screen.queryByText("No issues detected! Great job!")).toBeNull();
	});

	it("counts the issues by severity and folds the list", async () => {
		renderPanel(
			score([
				issue(1, { severity: "high" }),
				issue(2, { severity: "high" }),
				issue(3, { severity: "medium" }),
				issue(4, { severity: "low" }),
			]),
		);
		const toggle = screen.getByRole("button", { name: "4 Issues Detected" });
		expect(screen.getByText("2 High")).toBeInTheDocument();
		expect(screen.getByText("1 Medium")).toBeInTheDocument();
		expect(screen.getByText("1 Low")).toBeInTheDocument();
		expect(screen.queryByText(/Critical/)).toBeNull();

		await userEvent.click(toggle);
		expect(screen.queryByText("2 High")).toBeNull();
		await userEvent.click(toggle);
		expect(screen.getByText("2 High")).toBeInTheDocument();
	});

	it("leaves out the severities no issue has", () => {
		renderPanel(score([issue(1, { severity: "critical" })]));
		expect(screen.getByText("1 Critical")).toBeInTheDocument();
		expect(screen.queryByText(/High|Medium|Low/)).toBeNull();
	});

	it("opens a category to read its issues, five at most", async () => {
		renderPanel(
			score([
				issue(1, { severity: "critical", line: 12, suggestion: "Check for null" }),
				issue(2, { severity: "high" }),
				issue(3, { severity: "medium" }),
				issue(4),
				issue(5),
				issue(6),
				issue(7),
				issue(8, { category: "maintainability" }),
				issue(9, { category: "complexity" }),
				issue(10, { category: "style" as QualityIssue["category"] }),
			]),
		);
		const bugs = screen.getByRole("button", { name: /Bugs/ });
		expect(bugs).toHaveAttribute("aria-expanded", "false");
		expect(within(bugs).getByText("7")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Maintainability/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Complexity/ })).toBeInTheDocument();
		// A category without a translation shows its own name.
		expect(screen.getByRole("button", { name: /style/ })).toBeInTheDocument();
		expect(screen.queryByText("Issue 1")).toBeNull();

		await userEvent.click(bugs);
		expect(bugs).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Issue 1")).toBeInTheDocument();
		expect(screen.getByText("src/file1.ts:12")).toBeInTheDocument();
		expect(screen.getByText("Check for null")).toBeInTheDocument();
		expect(screen.getByText("src/file2.ts")).toBeInTheDocument();
		expect(screen.getByText("Issue 5")).toBeInTheDocument();
		expect(screen.queryByText("Issue 6")).toBeNull();
		expect(screen.getByText("... and 2 more")).toBeInTheDocument();

		await userEvent.click(bugs);
		expect(screen.queryByText("Issue 1")).toBeNull();
	});

	it("does not add a count line under a short category", async () => {
		renderPanel(score([issue(1, { category: "security" })]));
		await userEvent.click(screen.getByRole("button", { name: /Security/ }));
		expect(screen.getByText("Issue 1")).toBeInTheDocument();
		expect(screen.queryByText(/and \d+ more/)).toBeNull();
	});
});
