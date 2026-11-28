/**
 * Picking the findings of a review to post: by severity group, by
 * importance, one by one, every one or none. Posted findings leave the list.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../../../../shared/i18n";
import type { PRReviewFinding } from "../../hooks/useGitHubPRs";
import { ReviewFindings } from "../ReviewFindings";

const finding = (
	id: string,
	severity: PRReviewFinding["severity"],
	fields: Partial<PRReviewFinding> = {},
): PRReviewFinding => ({
	id,
	severity,
	category: "quality",
	title: `Finding ${id}`,
	description: `About ${id}`,
	file: "src/app.ts",
	line: 3,
	fixable: false,
	...fields,
});

const FINDINGS = [
	finding("c1", "critical", { category: "test" }),
	finding("h1", "high", { category: "verification_failed", endLine: 9 }),
	finding("m1", "medium", { category: "docs", suggestedFix: "Add a doc" }),
	finding("m2", "medium", { category: "brand-new" as never }),
	finding("l1", "low"),
];

function Harness({
	findings = FINDINGS,
	postedIds,
}: {
	findings?: PRReviewFinding[];
	postedIds?: Set<string>;
}) {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	return (
		<>
			<output data-testid="selected">{[...selected].sort().join(",")}</output>
			<ReviewFindings
				findings={findings}
				selectedIds={selected}
				postedIds={postedIds}
				onSelectionChange={setSelected}
			/>
		</>
	);
}

const selected = () => screen.getByTestId("selected").textContent;
const group = (name: string) =>
	screen.getByRole("checkbox", { name: `Select every ${name} finding` });

describe("ReviewFindings", () => {
	afterEach(() => i18n.changeLanguage("en"));

	it("opens the serious groups and folds the others", async () => {
		render(<Harness />);
		expect(screen.getByText("Finding c1")).toBeInTheDocument();
		expect(screen.getByText("Finding h1")).toBeInTheDocument();
		expect(screen.queryByText("Finding m1")).toBeNull();

		const recommended = screen.getByRole("button", { name: /Recommended/ });
		expect(recommended).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(recommended);
		expect(screen.getByText("Finding m1")).toBeInTheDocument();
		expect(screen.getByText("Add a doc")).toBeInTheDocument();
		await userEvent.click(recommended);
		expect(screen.queryByText("Finding m1")).toBeNull();
	});

	it("names each finding's category, and keeps one it does not know", async () => {
		await i18n.changeLanguage("fr");
		render(<Harness />);
		expect(screen.getByText("Tests")).toBeInTheDocument();
		expect(screen.getByText("Non vérifié")).toBeInTheDocument();
		expect(screen.getByText("src/app.ts:3-9")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /Recommandé/ }));
		expect(screen.getByText("Documentation")).toBeInTheDocument();
		expect(screen.getByText("brand-new")).toBeInTheDocument();
	});

	it("selects a whole group from the keyboard, then clears it", async () => {
		render(<Harness />);
		const recommended = group("Recommended");
		expect(recommended).toHaveAttribute("aria-checked", "false");
		recommended.focus();
		await userEvent.keyboard(" ");
		expect(selected()).toBe("m1,m2");
		expect(recommended).toHaveAttribute("aria-checked", "true");
		// Picking the group did not open or close it.
		expect(screen.queryByText("Finding m1")).toBeNull();
		await userEvent.click(recommended);
		expect(selected()).toBe("");
	});

	it("shows a group half picked, and picks the rest of it", async () => {
		render(<Harness findings={[...FINDINGS, finding("c2", "critical")]} />);
		await userEvent.click(screen.getByRole("checkbox", { name: "Finding c1" }));
		expect(group("Blocker")).toHaveAttribute("aria-checked", "mixed");
		await userEvent.click(group("Blocker"));
		expect(selected()).toBe("c1,c2");
		await userEvent.click(screen.getByRole("checkbox", { name: "Finding c2" }));
		expect(selected()).toBe("c1");
	});

	it("selects the important ones, every one, or none", async () => {
		render(<Harness />);
		const none = screen.getByRole("button", { name: "Clear" });
		expect(none).toBeDisabled();
		await userEvent.click(screen.getByRole("button", { name: "Select Blocker/Required (2)" }));
		expect(selected()).toBe("c1,h1");
		await userEvent.click(screen.getByRole("button", { name: "Select All" }));
		expect(selected()).toBe("c1,h1,l1,m1,m2");
		await userEvent.click(none);
		expect(selected()).toBe("");
	});

	it("lists only what is left to post", () => {
		render(<Harness postedIds={new Set(["c1", "h1"])} />);
		expect(screen.queryByText("Finding c1")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Select Blocker/Required (0)" }),
		).toBeDisabled();
		expect(within(screen.getByRole("button", { name: /Suggestion/ })).getByText("1")).toBeInTheDocument();
	});

	it("says when everything was posted, or nothing was found", () => {
		const { unmount } = render(<Harness postedIds={new Set(FINDINGS.map((f) => f.id))} />);
		expect(screen.getByText("All findings posted to GitHub")).toBeInTheDocument();
		expect(screen.getByText("5 findings posted to GitHub")).toBeInTheDocument();
		unmount();
		render(<Harness findings={[]} />);
		expect(screen.getByText("No issues found! The code looks good.")).toBeInTheDocument();
	});
});
