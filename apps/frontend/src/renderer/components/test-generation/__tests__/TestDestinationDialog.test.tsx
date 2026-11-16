/**
 * The question asked when the backend cannot justify where generated tests go:
 * the project's candidates first (the first one chosen), or a directory typed
 * or browsed for.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDestination } from "../../../../shared/types/test-generation";
import { TestDestinationDialog } from "../TestDestinationDialog";

const selectDirectory = vi.fn();
const onConfirm = vi.fn();
const onCancel = vi.fn();

function destination(overrides: Partial<TestDestination> = {}): TestDestination {
	return {
		directory: "/p/tests",
		fileName: "test_app.py",
		path: "/p/tests/test_app.py",
		status: "needs_choice",
		reason: "no_tests_dir",
		projectRoot: "/p",
		sourceRoot: "/p/src",
		candidates: [
			{ path: "/p/tests", kind: "sibling_of_source_root", exists: false },
			{ path: "/p/spec", kind: "existing_tests_dir", exists: true },
		],
		...overrides,
	} as TestDestination;
}

function renderDialog(value: TestDestination | null, note?: string) {
	return render(
		<TestDestinationDialog destination={value} onConfirm={onConfirm} onCancel={onCancel} note={note} />,
	);
}

const confirmButton = () => screen.getByRole("button", { name: "Write tests here" });
const customField = () => screen.getByRole("textbox", { name: "Another directory" });

describe("TestDestinationDialog", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		Object.assign(globalThis.electronAPI, { selectDirectory });
	});

	it("shows nothing without a question", () => {
		renderDialog(null);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("lists the candidates and writes to the first one by default", async () => {
		renderDialog(destination(), "Reused for the rest of the batch");

		expect(screen.getByRole("dialog", { name: "Where should these tests go?" })).toBeInTheDocument();
		expect(screen.getByText(/keeps its sources in \/p\/src/)).toBeInTheDocument();
		expect(screen.getByText("test_app.py")).toBeInTheDocument();
		expect(screen.getByText("Beside the source directory · will be created")).toBeInTheDocument();
		expect(screen.getByText("Existing test directory")).toBeInTheDocument();
		expect(screen.getByText("Reused for the rest of the batch")).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: /\/p\/tests/ })).toBeChecked();

		await userEvent.click(confirmButton());
		expect(onConfirm).toHaveBeenCalledWith("/p/tests");
	});

	it("writes to another candidate once chosen", async () => {
		renderDialog(destination());
		await userEvent.click(screen.getByRole("radio", { name: /\/p\/spec/ }));
		await userEvent.click(confirmButton());
		expect(onConfirm).toHaveBeenCalledWith("/p/spec");
	});

	it("asks for a directory of one's own when the project offers none", async () => {
		renderDialog(destination({ reason: "no_source_root", sourceRoot: null, candidates: [] }));

		expect(screen.getByText(/No source or test directory could be found/)).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Another directory" })).toBeChecked();
		expect(confirmButton()).toBeDisabled();

		await userEvent.type(customField(), "   ");
		expect(confirmButton()).toBeDisabled();
		await userEvent.clear(customField());
		await userEvent.type(customField(), "  tests/App.UnitTests ");
		await userEvent.click(confirmButton());
		expect(onConfirm).toHaveBeenCalledWith("tests/App.UnitTests");
	});

	it("chooses the typed directory as soon as one types", async () => {
		renderDialog(destination());
		await userEvent.type(customField(), "qa");
		expect(screen.getByRole("radio", { name: "Another directory" })).toBeChecked();
		await userEvent.click(confirmButton());
		expect(onConfirm).toHaveBeenCalledWith("qa");
	});

	it("fills the directory picked in the browser", async () => {
		selectDirectory.mockResolvedValue("/elsewhere/tests");
		renderDialog(destination());

		await userEvent.click(screen.getByRole("button", { name: "Browse for a directory" }));

		expect(customField()).toHaveValue("/elsewhere/tests");
		expect(screen.getByRole("radio", { name: "Another directory" })).toBeChecked();
	});

	it.each([
		["is closed without a choice", () => selectDirectory.mockResolvedValue(null)],
		["fails", () => selectDirectory.mockRejectedValue(new Error("no dialog"))],
	])("keeps the current choice when the browser %s", async (_label, arrange) => {
		arrange();
		renderDialog(destination());

		await userEvent.click(screen.getByRole("button", { name: "Browse for a directory" }));

		expect(customField()).toHaveValue("");
		expect(screen.getByRole("radio", { name: /\/p\/tests/ })).toBeChecked();
	});

	it("asks again from the first candidate for a new question", async () => {
		const { rerender } = renderDialog(destination());
		await userEvent.type(customField(), "qa");

		rerender(
			<TestDestinationDialog
				destination={destination({ candidates: [{ path: "/q/tests", kind: "project_tests", exists: true }] })}
				onConfirm={onConfirm}
				onCancel={onCancel}
			/>,
		);

		expect(customField()).toHaveValue("");
		expect(screen.getByRole("radio", { name: /\/q\/tests/ })).toBeChecked();
		expect(screen.getByText("At the project root")).toBeInTheDocument();
	});

	it("cancels from the button and from Escape", async () => {
		renderDialog(destination());
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);

		await userEvent.keyboard("[Escape]");
		expect(onCancel).toHaveBeenCalledTimes(2);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("names a candidate next to its source file", () => {
		renderDialog(destination({ candidates: [{ path: "/p/src/pkg", kind: "source_dir", exists: true }] }));
		expect(screen.getByText("Next to the source file")).toBeInTheDocument();
	});
});
