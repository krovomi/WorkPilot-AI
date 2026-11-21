/**
 * The Formula Lab badge on a Kanban card, and the success ring it draws: an
 * "estimate" call-to-action before any formula is applied, the applied formula
 * after, and either way a click that opens the lab on this ticket without
 * opening the card underneath.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Task } from "../../../../shared/types/task";
import { useFormulaMatrixStore } from "../../../stores/formula-matrix-store";
import { FormulaBadge } from "../FormulaBadge";
import { SuccessRing } from "../SuccessRing";

const INITIAL = useFormulaMatrixStore.getState();

function task(over: Partial<Task> = {}): Task {
	return {
		id: "task-7",
		specId: "007-search",
		projectId: "p1",
		title: "Add search",
		description: "Full-text search on cards",
		status: "backlog",
		subtasks: [],
		logs: [],
		createdAt: new Date("2026-11-01T10:00:00Z"),
		updatedAt: new Date("2026-11-01T10:00:00Z"),
		...over,
	} as Task;
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	(globalThis as { electronAPI?: unknown }).electronAPI = {
		runFormulaMatrix: vi.fn(() => new Promise(() => undefined)),
	};
	useFormulaMatrixStore.setState(INITIAL, true);
});

describe("FormulaBadge", () => {
	it("offers an estimate and opens the lab on the ticket", () => {
		// The card under the badge listens above React's root; the click must not reach it.
		const onCardClick = vi.fn();
		document.body.addEventListener("click", onCardClick);
		render(
			<FormulaBadge task={task()} projectPath="/projects/demo" specDir="007-search" />,
		);
		const button = screen.getByRole("button", { name: "Estimate" });
		expect(button).toHaveAttribute(
			"title",
			"Estimate cost & success across Provider × LLM × Effort",
		);
		fireEvent.click(button);

		expect(onCardClick).not.toHaveBeenCalled();
		document.body.removeEventListener("click", onCardClick);
		const state = useFormulaMatrixStore.getState();
		expect(state.isOpen).toBe(true);
		expect(state.ticketTitle).toBe("Add search");
		expect(state.selectedKey).toBeNull();
		expect(state.openArgs).toEqual({
			ticketId: "task-7",
			ticketTitle: "Add search",
			description: "Full-text search on cards",
			projectPath: "/projects/demo",
			specDir: "007-search",
			appliedKey: undefined,
		});
	});

	it("shows the applied formula and reopens the lab on it", () => {
		render(
			<FormulaBadge
				task={task({
					metadata: {
						appliedFormula: {
							provider: "anthropic",
							model: "claude-sonnet-5-20260301",
							effort: "high",
							expectedCostUsd: 1,
							successProbability: 0.82,
							perTokenBilled: true,
							appliedAt: "2026-11-02T09:00:00Z",
						},
					},
				})}
			/>,
		);
		const button = screen.getByRole("button", { name: /sonnet-5·High/ });
		expect(button).toHaveTextContent("€0.92");
		expect(button).toHaveAttribute("title", "Applied formula — click to change");
		expect(screen.getByRole("img", { name: "82% success" })).toBeInTheDocument();

		fireEvent.click(button);
		const state = useFormulaMatrixStore.getState();
		expect(state.selectedKey).toBe("anthropic::claude-sonnet-5-20260301::high");
		expect(state.appliedKey).toBe("anthropic::claude-sonnet-5-20260301::high");
	});
});

describe("SuccessRing", () => {
	const stroke = () =>
		screen.getByRole("img").querySelectorAll("circle")[1].getAttribute("stroke");

	it.each([
		[0.9, "90%", "#10b981"],
		[0.75, "75%", "#22c55e"],
		[0.6, "60%", "#f59e0b"],
		[0.45, "45%", "#f97316"],
		[0.2, "20%", "#ef4444"],
		[1.4, "100%", "#10b981"],
		[-0.3, "0%", "#ef4444"],
	])("draws %s as %s in its risk colour", (value, percent, color) => {
		render(<SuccessRing value={value} />);
		expect(screen.getByRole("img", { name: `${percent} success` })).toBeInTheDocument();
		expect(screen.getByText(percent.replace("%", ""))).toBeInTheDocument();
		expect(stroke()).toBe(color);
	});

	it("can hide the number in the centre", () => {
		const { container } = render(<SuccessRing value={0.5} showLabel={false} />);
		expect(screen.getByRole("img", { name: "50% success" })).toBeInTheDocument();
		expect(container).not.toHaveTextContent("50");
	});
});
