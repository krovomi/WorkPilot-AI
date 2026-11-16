/**
 * The findings of an MR review, grouped by severity: what is selected for
 * posting, by finding, by group or in one click, and what was already posted.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { GitLabMRReviewFinding } from "../../../../../shared/types";
import { FindingItem } from "../FindingItem";
import { ReviewFindings } from "../ReviewFindings";

const t = (key: string, options?: Record<string, unknown>) =>
	i18n.t(`gitlab:${key}`, options ?? {});

const finding = (
	id: string,
	severity: GitLabMRReviewFinding["severity"],
	over: Partial<GitLabMRReviewFinding> = {},
): GitLabMRReviewFinding => ({
	id,
	severity,
	category: "security",
	title: `Finding ${id}`,
	description: `Why ${id} matters`,
	file: "src/app.ts",
	line: 10,
	fixable: false,
	...over,
});

const FINDINGS = [
	finding("a", "critical"),
	finding("b", "high"),
	finding("c", "medium", { category: "performance" }),
	finding("d", "low"),
];

function Harness({
	findings = FINDINGS,
	initial = [],
	posted,
}: {
	findings?: GitLabMRReviewFinding[];
	initial?: string[];
	posted?: Set<string>;
}) {
	const [selected, setSelected] = useState(new Set(initial));
	return (
		<>
			<output data-testid="selected">{[...selected].sort().join(",")}</output>
			<ReviewFindings
				findings={findings}
				selectedIds={selected}
				postedIds={posted}
				onSelectionChange={setSelected}
			/>
		</>
	);
}

const selected = () => screen.getByTestId("selected").textContent;
const groupBox = (severity: string) =>
	screen.getByRole("checkbox", {
		name: t("findings.selectSeverityGroup", {
			severity: t(`findings.severity.${severity}`),
		}),
	});
const fold = (severity: string) =>
	screen.getByRole("button", {
		name: new RegExp(`^${t(`findings.severity.${severity}`)}`),
	});

describe("ReviewFindings", () => {
	it("counts each severity and shows the blocking groups open", () => {
		render(<Harness initial={["a"]} />);

		for (const severity of ["critical", "high", "medium", "low"]) {
			expect(
				screen.getByText(t(`findings.counts.${severity}`, { count: 1 })),
			).toBeInTheDocument();
		}
		expect(
			screen.getByText(t("findings.selectedOfTotal", { selected: 1, total: 4 })),
		).toBeInTheDocument();
		expect(fold("critical")).toHaveAttribute("aria-expanded", "true");
		expect(fold("medium")).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByText("Finding a")).toBeInTheDocument();
		expect(screen.queryByText("Finding c")).not.toBeInTheDocument();
	});

	it("opens and folds a group", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(fold("medium"));
		expect(screen.getByText("Finding c")).toBeInTheDocument();
		expect(screen.getByText(t("findings.category.performance"))).toBeVisible();

		await user.click(fold("critical"));
		expect(screen.queryByText("Finding a")).not.toBeInTheDocument();
	});

	it("selects the blocking findings, all of them, or none", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(
			screen.getByRole("button", {
				name: t("findings.selectImportant", { count: 2 }),
			}),
		);
		expect(selected()).toBe("a,b");

		await user.click(
			screen.getByRole("button", { name: t("findings.selectAll") }),
		);
		expect(selected()).toBe("a,b,c,d");

		await user.click(screen.getByRole("button", { name: t("findings.clear") }));
		expect(selected()).toBe("");
		expect(screen.getByRole("button", { name: t("findings.clear") })).toBeDisabled();
	});

	it("toggles one finding with its own checkbox", async () => {
		const user = userEvent.setup();
		render(<Harness />);

		await user.click(screen.getByRole("checkbox", { name: "Finding b" }));
		expect(selected()).toBe("b");
		await user.click(screen.getByRole("checkbox", { name: "Finding b" }));
		expect(selected()).toBe("");
	});

	it("selects a whole group from its header, then clears it", async () => {
		const user = userEvent.setup();
		const findings = [finding("a", "critical"), finding("e", "critical")];
		render(<Harness findings={findings} initial={["a"]} />);

		expect(groupBox("critical")).toHaveAttribute("data-state", "indeterminate");
		await user.click(groupBox("critical"));
		expect(selected()).toBe("a,e");
		expect(groupBox("critical")).toHaveAttribute("data-state", "checked");

		await user.click(groupBox("critical"));
		expect(selected()).toBe("");
		expect(groupBox("critical")).toHaveAttribute("data-state", "unchecked");
	});

	it("shows a posted finding as posted, without a checkbox", () => {
		render(<Harness posted={new Set(["a"])} />);

		expect(
			screen.queryByRole("checkbox", { name: "Finding a" }),
		).not.toBeInTheDocument();
		expect(screen.getByText(t("findings.posted"))).toBeInTheDocument();
	});

	it("leaves out a finding of a severity it does not know", () => {
		const odd = {
			...finding("z", "low"),
			severity: "info",
		} as unknown as GitLabMRReviewFinding;
		render(<Harness findings={[odd]} />);

		expect(screen.queryByText("Finding z")).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: t("findings.selectImportant", { count: 0 }),
			}),
		).toBeDisabled();
	});

	it("says the code looks good when there is nothing to report", () => {
		render(<Harness findings={[]} />);
		expect(screen.getByText(t("findings.noIssues"))).toBeInTheDocument();
	});
});

describe("FindingItem", () => {
	const noop = () => undefined;

	it("shows where the finding is and how to fix it", () => {
		render(
			<FindingItem
				finding={finding("f", "high", {
					endLine: 14,
					suggestedFix: "escape(input)",
				})}
				selected
				onToggle={noop}
			/>,
		);

		expect(screen.getByText("src/app.ts:10-14")).toBeInTheDocument();
		expect(screen.getByText(t("findings.suggestedFix"))).toBeInTheDocument();
		expect(screen.getByText("escape(input)")).toBeInTheDocument();
		expect(screen.getByText(t("findings.category.security"))).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Finding f" })).toBeChecked();
	});

	it("names one line once, and shows a category it has no word for as is", () => {
		const unknown = {
			...finding("g", "low", { endLine: 10 }),
			category: "logic",
		} as unknown as GitLabMRReviewFinding;
		const { container } = render(
			<FindingItem finding={unknown} selected={false} onToggle={noop} />,
		);

		expect(within(container).getByText("src/app.ts:10")).toBeInTheDocument();
		expect(screen.getByText("logic")).toBeInTheDocument();
		expect(screen.queryByText(t("findings.suggestedFix"))).not.toBeInTheDocument();
	});
});
