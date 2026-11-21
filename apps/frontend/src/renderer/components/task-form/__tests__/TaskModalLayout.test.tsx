/**
 * @vitest-environment jsdom
 */

/**
 * TaskModalLayout — the large modal of the task forms: title, description,
 * body, footer and an optional sidebar; closing goes through the caller's
 * handler once, and not at all while the form is busy.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { TaskModalLayout } from "../TaskModalLayout";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(cleanup);

function renderLayout(props: Partial<Parameters<typeof TaskModalLayout>[0]> = {}) {
	const onOpenChange = vi.fn();
	render(
		<TaskModalLayout
			open
			onOpenChange={onOpenChange}
			title="New task"
			footer={<span>Footer actions</span>}
			{...props}
		>
			<p>Body content</p>
		</TaskModalLayout>,
	);
	return onOpenChange;
}

describe("TaskModalLayout", () => {
	it("shows the title, the description, the body and the footer", () => {
		renderLayout({ description: "Describe what to build" });
		const dialog = screen.getByRole("dialog", { name: "New task" });
		expect(dialog).toHaveAccessibleDescription("Describe what to build");
		expect(screen.getByText("Body content")).toBeInTheDocument();
		expect(screen.getByText("Footer actions")).toBeInTheDocument();
	});

	it("shows the sidebar only while it is open", () => {
		renderLayout({ sidebar: <aside>File explorer</aside> });
		expect(screen.queryByText("File explorer")).not.toBeInTheDocument();
		cleanup();
		renderLayout({ sidebar: <aside>File explorer</aside>, sidebarOpen: true });
		expect(screen.getByText("File explorer")).toBeInTheDocument();
	});

	it("closes once through the close button", () => {
		const onOpenChange = renderLayout();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onOpenChange).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("hands the close to the caller's handler, once, when it has one", () => {
		const onClose = vi.fn();
		const onOpenChange = renderLayout({ onClose });
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(2);
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("stays open while the form is busy", () => {
		const onClose = vi.fn();
		const onOpenChange = renderLayout({ onClose, disabled: true });
		expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});
