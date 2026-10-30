/**
 * Rules from reviews (IA1): a candidate reaches no agent until the person
 * adopts it, in the wording they leave in the box.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewLesson } from "../../../../shared/types/learning-loop";
import { useLearningLoopStore } from "../../../stores/learning-loop-store";
import { ReviewLessonsSection } from "../ReviewLessonsSection";

vi.mock("react-i18next", () => {
	const t = (key: string, options?: Record<string, unknown>) =>
		options?.flags ? `${key}:${options.flags}` : key;
	return { useTranslation: () => ({ t, i18n: { language: "en" } }) };
});

const PROJECT = "/home/dev/shop";

const api = {
	adoptReviewLesson: vi.fn(),
	dismissReviewLesson: vi.fn(),
};

function lesson(overrides: Partial<ReviewLesson> = {}): ReviewLesson {
	return {
		id: "l1",
		source: "pr_review",
		status: "pending",
		text: "pls use async here",
		rule: "",
		flags: [],
		origin: {
			author: "reviewer",
			path: "src/Api/OrdersController.cs",
			pr_url: "https://github.com/acme/shop/pull/7",
		},
		seen_at: "2026-10-30T12:00:00Z",
		decided_at: "",
		...overrides,
	};
}

describe("ReviewLessonsSection", () => {
	beforeEach(() => {
		vi.stubGlobal("electronAPI", api);
		api.adoptReviewLesson.mockReset();
		api.dismissReviewLesson.mockReset();
	});
	afterEach(() => {
		useLearningLoopStore.getState().reset();
		vi.unstubAllGlobals();
	});

	it("shows nothing without candidates or rules", () => {
		const { container } = render(<ReviewLessonsSection projectDir={PROJECT} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("adopts a candidate in the wording the person typed", async () => {
		useLearningLoopStore.getState().setLessons([lesson()]);
		api.adoptReviewLesson.mockResolvedValue({
			success: true,
			data: lesson({ status: "adopted", rule: "Call the async EF Core overloads." }),
		});
		render(<ReviewLessonsSection projectDir={PROJECT} />);

		fireEvent.change(
			screen.getByRole("textbox", { name: "learningLoop:lessons.ruleLabel" }),
			{ target: { value: "  Call the async EF Core overloads.  " } },
		);
		fireEvent.click(screen.getByRole("button", { name: /lessons.adopt/ }));

		await waitFor(() =>
			expect(screen.getByText("Call the async EF Core overloads.")).toBeInTheDocument(),
		);
		expect(api.adoptReviewLesson).toHaveBeenCalledWith(
			PROJECT,
			"l1",
			"Call the async EF Core overloads.",
		);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});

	it("cannot adopt an empty rule", () => {
		useLearningLoopStore.getState().setLessons([lesson()]);
		render(<ReviewLessonsSection projectDir={PROJECT} />);

		fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });

		expect(screen.getByRole("button", { name: /lessons.adopt/ })).toBeDisabled();
	});

	it("dismisses a candidate, and it leaves the list", async () => {
		useLearningLoopStore.getState().setLessons([lesson()]);
		api.dismissReviewLesson.mockResolvedValue({ success: true });
		const { container } = render(<ReviewLessonsSection projectDir={PROJECT} />);

		fireEvent.click(screen.getByRole("button", { name: /lessons.dismiss/ }));

		await waitFor(() => expect(container).toBeEmptyDOMElement());
		expect(api.dismissReviewLesson).toHaveBeenCalledWith(PROJECT, "l1");
	});

	it("warns before adopting a comment that looks aimed at an agent", () => {
		useLearningLoopStore
			.getState()
			.setLessons([lesson({ flags: ["Text addressed to the agent"] })]);
		render(<ReviewLessonsSection projectDir={PROJECT} />);

		expect(
			screen.getByText(
				"learningLoop:lessons.flagged:Text addressed to the agent",
			),
		).toBeInTheDocument();
	});

	it("withdraws an adopted rule", async () => {
		useLearningLoopStore
			.getState()
			.setLessons([lesson({ status: "adopted", rule: "Keep EF out of Domain." })]);
		api.dismissReviewLesson.mockResolvedValue({ success: true });
		render(<ReviewLessonsSection projectDir={PROJECT} />);

		fireEvent.click(screen.getByRole("button", { name: /lessons.withdraw/ }));

		await waitFor(() =>
			expect(screen.queryByText("Keep EF out of Domain.")).not.toBeInTheDocument(),
		);
	});
});
