/**
 * The quality grade badge: an emoji and the grade, with the score explained on hover.
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../../../shared/i18n";
import { QualityScoreBadge } from "../QualityScoreBadge";
import { TooltipProvider } from "../ui/tooltip";

function renderBadge(props: Partial<Parameters<typeof QualityScoreBadge>[0]> = {}) {
	return render(
		<TooltipProvider>
			<QualityScoreBadge score={87.46} grade="A" isPassing {...props} />
		</TooltipProvider>,
	);
}

describe("QualityScoreBadge", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
	});

	it("shows the grade with its emoji and explains the score on focus", async () => {
		renderBadge();
		const badge = screen.getByText("⭐ A");
		expect(badge.className).toContain("bg-success");

		fireEvent.focus(badge);
		expect((await screen.findAllByText("Code Quality Score")).length).toBeGreaterThan(0);
		expect(screen.getAllByText("87.5/100 (Grade: A)").length).toBeGreaterThan(0);
		expect(screen.getAllByText("✅ Passing").length).toBeGreaterThan(0);
	});

	it("says when the code does not pass", async () => {
		renderBadge({ grade: "F", score: 31, isPassing: false });
		const badge = screen.getByText("❌ F");
		expect(badge.className).toContain("bg-destructive");

		fireEvent.focus(badge);
		expect((await screen.findAllByText("❌ Failed")).length).toBeGreaterThan(0);
		expect(screen.getAllByText("31.0/100 (Grade: F)").length).toBeGreaterThan(0);
	});

	it("falls back to a neutral badge for a grade it does not know", () => {
		renderBadge({ grade: "E", className: "ml-2" });
		const badge = screen.getByText("📊 E");
		expect(badge.className).toContain("bg-gray-500");
		expect(badge.className).toContain("ml-2");
	});

	it("renders the bare badge when the tooltip is turned off", () => {
		renderBadge({ grade: "B+", showTooltip: false });
		const badge = screen.getByText("👍 B+");
		expect(badge.className).toContain("bg-lime-500");
		fireEvent.focus(badge);
		expect(screen.queryByText("Code Quality Score")).toBeNull();
	});
});
