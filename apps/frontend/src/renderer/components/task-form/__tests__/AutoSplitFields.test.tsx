/**
 * @vitest-environment jsdom
 */

/**
 * AutoSplitFields — a task's own say on the automatic split: keep it whole,
 * or give it a ceiling of changed lines per pull request. The helpers turn the
 * value into the task's metadata and back.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import {
	type AutoSplitValue,
	AutoSplitFields,
	autoSplitMetadata,
	autoSplitValueFrom,
	DEFAULT_AUTO_SPLIT_VALUE,
	isAutoSplitValueValid,
} from "../AutoSplitFields";

beforeEach(async () => {
	await i18n.changeLanguage("en");
});
afterEach(cleanup);

function Harness({
	initial = DEFAULT_AUTO_SPLIT_VALUE,
	onChange = vi.fn(),
	...props
}: {
	initial?: AutoSplitValue;
	onChange?: (value: AutoSplitValue) => void;
} & Omit<Parameters<typeof AutoSplitFields>[0], "value" | "onChange">) {
	const [value, setValue] = useState(initial);
	return (
		<AutoSplitFields
			value={value}
			onChange={(next) => {
				setValue(next);
				onChange(next);
			}}
			{...props}
		/>
	);
}

const toggle = () =>
	screen.getByRole("checkbox", {
		name: "Split automatically when the task is too big",
	});
const ceiling = () => screen.queryByLabelText("Max lines to review per PR");

describe("AutoSplitFields", () => {
	it("shows the project's ceiling for the kind and checks the number typed", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} projectMaxLines={250} kind="bug_fix" />);
		expect(toggle()).toBeChecked();
		expect(ceiling()).toHaveAttribute("placeholder", "250 (project, Bug fix)");
		expect(ceiling()).toHaveAttribute("id", "auto-split-lines");
		expect(screen.getByText(/Leave empty to use the project's ceiling/)).toBeInTheDocument();

		fireEvent.change(ceiling() as HTMLElement, { target: { value: "12" } });
		expect(onChange).toHaveBeenLastCalledWith({ noSplit: false, maxLines: "12" });
		expect(ceiling()).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByText("Enter a whole number between 50 and 20000."),
		).toHaveClass("text-destructive");

		fireEvent.change(ceiling() as HTMLElement, { target: { value: "600" } });
		expect(ceiling()).toHaveAttribute("aria-invalid", "false");
	});

	it("uses the default ceiling of the kind, or says the kind is never split", () => {
		render(<Harness idPrefix="edit" />);
		expect(ceiling()).toHaveAttribute("placeholder", "400 (project, Feature)");
		expect(ceiling()).toHaveAttribute("id", "edit-auto-split-lines");
		cleanup();

		render(<Harness kind="spike" />);
		expect(ceiling()).toHaveAttribute("placeholder", "never split (Spike / study)");
	});

	it("keeps the task whole when unchecked, and gives it back its ceiling", () => {
		const onChange = vi.fn();
		render(<Harness onChange={onChange} />);
		fireEvent.click(toggle());
		expect(onChange).toHaveBeenLastCalledWith({ noSplit: true, maxLines: "" });
		expect(ceiling()).not.toBeInTheDocument();

		fireEvent.click(toggle());
		expect(onChange).toHaveBeenLastCalledWith({ noSplit: false, maxLines: "" });
		expect(ceiling()).toBeInTheDocument();
	});

	it("cannot turn the split on when the project turned it off", () => {
		render(<Harness projectDisabled />);
		expect(toggle()).not.toBeChecked();
		expect(toggle()).toBeDisabled();
		expect(
			screen.getByText("Automatic splitting is turned off in the project settings."),
		).toBeInTheDocument();
		expect(ceiling()).not.toBeInTheDocument();
	});

	it("locks both fields while the form is busy", () => {
		render(<Harness disabled />);
		expect(toggle()).toBeDisabled();
		expect(ceiling()).toBeDisabled();
	});
});

describe("auto-split metadata", () => {
	it("reads a task's metadata, defaults included", () => {
		expect(autoSplitValueFrom()).toEqual(DEFAULT_AUTO_SPLIT_VALUE);
		expect(autoSplitValueFrom({ noSplit: true, splitMaxLines: 300 })).toEqual({
			noSplit: true,
			maxLines: "300",
		});
	});

	it("stores nothing for a task on the project's defaults", () => {
		expect(autoSplitMetadata(DEFAULT_AUTO_SPLIT_VALUE)).toEqual({
			noSplit: undefined,
			splitMaxLines: undefined,
		});
		expect(autoSplitMetadata({ noSplit: false, maxLines: " 800 " })).toEqual({
			noSplit: undefined,
			splitMaxLines: 800,
		});
		expect(autoSplitMetadata({ noSplit: true, maxLines: "800" })).toEqual({
			noSplit: true,
			splitMaxLines: undefined,
		});
	});

	it("accepts a whole task, an empty ceiling or one in range", () => {
		expect(isAutoSplitValueValid({ noSplit: true, maxLines: "x" })).toBe(true);
		expect(isAutoSplitValueValid({ noSplit: false, maxLines: "  " })).toBe(true);
		expect(isAutoSplitValueValid({ noSplit: false, maxLines: "50" })).toBe(true);
		expect(isAutoSplitValueValid({ noSplit: false, maxLines: "49" })).toBe(false);
	});
});
