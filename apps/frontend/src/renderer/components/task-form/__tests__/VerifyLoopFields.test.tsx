/**
 * @vitest-environment jsdom
 */

/**
 * VerifyLoopFields — the verification loop of a card, and the one window a
 * Windows app is verified in. The window field shows only while the loop is
 * on, and only in the forms that save it.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { VerifyLoopFields } from "../VerifyLoopFields";

describe("VerifyLoopFields", () => {
	it("names the window to verify while the loop is on", () => {
		const onVerifyWindowChange = vi.fn();
		render(
			<VerifyLoopFields
				verifyLoop
				onVerifyLoopChange={vi.fn()}
				verifyWindow="Orders"
				onVerifyWindowChange={onVerifyWindowChange}
			/>,
		);
		const field = screen.getByLabelText("tasks:verify.form.windowLabel");
		expect(field).toHaveValue("Orders");
		expect(field).toHaveAttribute("maxLength", "200");
		fireEvent.change(field, { target: { value: "Orders — MyApp" } });
		expect(onVerifyWindowChange).toHaveBeenCalledWith("Orders — MyApp");
	});

	it("hides the window when the loop is off", () => {
		render(
			<VerifyLoopFields
				verifyLoop={false}
				onVerifyLoopChange={vi.fn()}
				verifyWindow="Orders"
				onVerifyWindowChange={vi.fn()}
			/>,
		);
		expect(screen.queryByLabelText("tasks:verify.form.windowLabel")).toBeNull();
	});

	it("shows no window field in a form that does not save it", () => {
		render(<VerifyLoopFields onVerifyLoopChange={vi.fn()} />);
		expect(screen.getByText("tasks:verify.form.label")).toBeInTheDocument();
		expect(screen.queryByLabelText("tasks:verify.form.windowLabel")).toBeNull();
	});

	it("turns the loop off", () => {
		const onVerifyLoopChange = vi.fn();
		render(<VerifyLoopFields verifyLoop onVerifyLoopChange={onVerifyLoopChange} />);
		fireEvent.click(screen.getByRole("checkbox"));
		expect(onVerifyLoopChange).toHaveBeenCalledWith(false);
	});
});
