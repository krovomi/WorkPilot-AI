/**
 * @vitest-environment jsdom
 */

/**
 * ClassificationFields — the category, priority, complexity and impact of a
 * task, each picked from its translated list.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { ClassificationFields } from "../ClassificationFields";

beforeAll(() => {
	Element.prototype.scrollIntoView = vi.fn();
	Element.prototype.hasPointerCapture = vi.fn(() => false);
	Element.prototype.releasePointerCapture = vi.fn();
});
beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(cleanup);

function renderFields(props: Partial<Parameters<typeof ClassificationFields>[0]> = {}) {
	const handlers = {
		onCategoryChange: vi.fn(),
		onPriorityChange: vi.fn(),
		onComplexityChange: vi.fn(),
		onImpactChange: vi.fn(),
	};
	render(
		<ClassificationFields
			category=""
			priority=""
			complexity=""
			impact=""
			{...handlers}
			{...props}
		/>,
	);
	return handlers;
}

async function pick(label: string, option: string) {
	fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" });
	fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("ClassificationFields", () => {
	it("starts on the placeholders and explains what the labels are for", () => {
		renderFields();
		expect(screen.getByText("Select category")).toBeInTheDocument();
		expect(screen.getByText("Select priority")).toBeInTheDocument();
		expect(screen.getByText("Select complexity")).toBeInTheDocument();
		expect(screen.getByText("Select impact")).toBeInTheDocument();
		expect(
			screen.getByText(/These labels help organize and prioritize tasks/),
		).toBeInTheDocument();
	});

	it("shows the translated value of each field, never its code", () => {
		renderFields({
			category: "bug_fix",
			priority: "urgent",
			complexity: "complex",
			impact: "critical",
			idPrefix: "edit",
		});
		expect(screen.getByRole("combobox", { name: "Category" })).toHaveTextContent("Bug Fix");
		expect(screen.getByRole("combobox", { name: "Priority" })).toHaveTextContent("Urgent");
		expect(screen.getByRole("combobox", { name: "Complexity" })).toHaveTextContent("Complex");
		expect(screen.getByRole("combobox", { name: "Impact" })).toHaveTextContent(
			"Critical Impact",
		);
		expect(screen.getByRole("combobox", { name: "Category" })).toHaveAttribute(
			"id",
			"edit-category",
		);
	});

	it("emits the value picked in each list", async () => {
		const handlers = renderFields();
		await pick("Category", "Security");
		expect(handlers.onCategoryChange).toHaveBeenCalledWith("security");
		await pick("Priority", "High");
		expect(handlers.onPriorityChange).toHaveBeenCalledWith("high");
		await pick("Complexity", "Trivial");
		expect(handlers.onComplexityChange).toHaveBeenCalledWith("trivial");
		await pick("Impact", "Low Impact");
		expect(handlers.onImpactChange).toHaveBeenCalledWith("low");
	});

	it("locks every list while the form is busy", () => {
		renderFields({ disabled: true });
		for (const name of ["Category", "Priority", "Complexity", "Impact"]) {
			expect(screen.getByRole("combobox", { name })).toBeDisabled();
		}
	});
});
