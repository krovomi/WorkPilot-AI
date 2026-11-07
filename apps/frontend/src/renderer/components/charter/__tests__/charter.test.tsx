/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import { CharterButton, Chip, Column, Composer, Gauge, ModuleStage, StepCard } from "..";

describe("UI charter primitives", () => {
	it("a stage carries the charter root class and its ambient layer", () => {
		const { container } = render(
			<ModuleStage data-testid="stage">
				<p>body</p>
			</ModuleStage>,
		);
		const stage = screen.getByTestId("stage");
		expect(stage).toHaveClass("wp-stage");
		expect(container.querySelector(".wp-ambient")).toHaveAttribute("aria-hidden", "true");
	});

	it("a column opens with kicker, title and meta", () => {
		render(
			<Column kicker="Source" title="Your design" meta="4 zones" tone="blue">
				<p>content</p>
			</Column>,
		);
		expect(screen.getByText("Source")).toHaveClass("wp-kicker");
		expect(screen.getByRole("heading", { name: "Your design" })).toBeInTheDocument();
		expect(screen.getByText("4 zones")).toHaveClass("wp-meta");
	});

	it("a clickable step numbers itself and reports its pressed state", () => {
		const onClick = vi.fn();
		render(<StepCard index={4} kicker="Code" title="Generate" active onClick={onClick} />);
		const step = screen.getByRole("button", { name: /04 · Code/ });
		expect(step).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(step);
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("a chip with onClick is a toggle, without it a label", () => {
		const onClick = vi.fn();
		const { rerender } = render(<Chip tone="red" pressed onClick={onClick}>High · 3</Chip>);
		expect(screen.getByRole("button", { name: "High · 3" })).toHaveAttribute("aria-pressed", "true");
		rerender(<Chip>4 files</Chip>);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("buttons default to type=button and a primary variant class", () => {
		render(<CharterButton variant="primary">Run</CharterButton>);
		const button = screen.getByRole("button", { name: "Run" });
		expect(button).toHaveAttribute("type", "button");
		expect(button).toHaveClass("wp-btn", "wp-btn-primary");
	});

	it("the gauge clamps its value", () => {
		render(<Gauge value={140} />);
		expect(screen.getByText("100%")).toBeInTheDocument();
	});

	it("the composer always keeps a second row, with options or a hint", () => {
		const { container } = render(<Composer actions={<button type="button">Go</button>} hint="Skipped: dist" />);
		expect(container.querySelectorAll(".wp-composer-row")).toHaveLength(2);
		expect(screen.getByText("Skipped: dist")).toBeInTheDocument();
	});
});
