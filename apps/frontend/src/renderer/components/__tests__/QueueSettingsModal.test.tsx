/**
 * How many tasks may run at once: a number between 1 and 10, checked on save.
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { QueueSettingsModal } from "../QueueSettingsModal";

function renderModal(props: Partial<Parameters<typeof QueueSettingsModal>[0]> = {}) {
	const onSave = vi.fn();
	const onOpenChange = vi.fn();
	const view = render(
		<QueueSettingsModal open onOpenChange={onOpenChange} onSave={onSave} {...props} />,
	);
	return { ...view, onSave, onOpenChange };
}

const input = () => screen.getByLabelText("Max Parallel Tasks") as HTMLInputElement;

describe("QueueSettingsModal", () => {
	beforeEach(async () => {
		await i18n.changeLanguage("en");
	});

	it("starts at 3 and saves the new value, then closes", () => {
		const { onSave, onOpenChange } = renderModal();
		expect(screen.getByText("Queue Settings")).toBeTruthy();
		expect(input().value).toBe("3");

		fireEvent.change(input(), { target: { value: "5" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(onSave).toHaveBeenCalledWith(5);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("refuses a value under 1 and says why", () => {
		const { onSave } = renderModal({ currentMaxParallel: 2 });
		fireEvent.change(input(), { target: { value: "" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(screen.getByText("Must be at least 1")).toBeTruthy();
		expect(onSave).not.toHaveBeenCalled();

		// Typing again clears the message.
		fireEvent.change(input(), { target: { value: "4" } });
		expect(screen.queryByText("Must be at least 1")).toBeNull();
	});

	it("refuses a value over 10 and says why", () => {
		const { onSave } = renderModal();
		fireEvent.change(input(), { target: { value: "11" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(screen.getByText("Cannot exceed 10")).toBeTruthy();
		expect(onSave).not.toHaveBeenCalled();
	});

	it("ignores a value that has no whole number in it", () => {
		renderModal({ currentMaxParallel: 6 });
		fireEvent.change(input(), { target: { value: ".5" } });
		expect(input().value).toBe("6");
	});

	it("cancels without saving", () => {
		const { onSave, onOpenChange } = renderModal();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(onSave).not.toHaveBeenCalled();
	});

	it("drops the edit and the error when it is opened again", () => {
		const onSave = vi.fn();
		const onOpenChange = vi.fn();
		const { rerender } = render(
			<QueueSettingsModal
				open
				onOpenChange={onOpenChange}
				onSave={onSave}
				currentMaxParallel={4}
			/>,
		);
		fireEvent.change(input(), { target: { value: "42" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(screen.getByText("Cannot exceed 10")).toBeTruthy();

		rerender(
			<QueueSettingsModal
				open={false}
				onOpenChange={onOpenChange}
				onSave={onSave}
				currentMaxParallel={4}
			/>,
		);
		rerender(
			<QueueSettingsModal
				open
				onOpenChange={onOpenChange}
				onSave={onSave}
				currentMaxParallel={4}
			/>,
		);
		expect(input().value).toBe("4");
		expect(screen.queryByText("Cannot exceed 10")).toBeNull();
	});
});
