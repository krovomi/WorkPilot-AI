/** @vitest-environment jsdom */
/**
 * The date, month and time fields write and read the app's language, not the
 * operating system's region (a French app showed mm/dd/yyyy in its sprint
 * dialog), and no native date input comes back in the renderer.
 */
import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import { DateField, MonthField, TimeField } from "../date-fields";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(2026, 10, 28, 10, 0));
	await i18n.changeLanguage("fr");
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

/** A field holding its own value, like the dialogs do. */
function Controlled({
	kind,
	initial,
	onChange,
	...rest
}: {
	kind: "date" | "month" | "time";
	initial: string;
	onChange?: (value: string) => void;
	min?: string;
	max?: string;
	disabled?: boolean;
}) {
	const [value, setValue] = useState(initial);
	const change = (next: string) => {
		onChange?.(next);
		setValue(next);
	};
	const props = { id: "f", "aria-label": "field", value, onValueChange: change, ...rest };
	if (kind === "date") return <DateField {...props} />;
	if (kind === "month") return <MonthField {...props} />;
	const { min: _min, max: _max, ...timeProps } = props;
	return <TimeField {...timeProps} />;
}

describe("DateField", () => {
	it("writes the day first in French and month first in English", async () => {
		const { rerender } = render(<DateField aria-label="field" value="2026-11-03" onValueChange={vi.fn()} />);
		const input = screen.getByLabelText("field");
		expect(input).toHaveValue("03/11/2026");
		expect(input).toHaveAttribute("placeholder", "jj/mm/aaaa");
		await act(() => i18n.changeLanguage("en"));
		rerender(<DateField aria-label="field" value="2026-11-03" onValueChange={vi.fn()} />);
		expect(input).toHaveValue("11/03/2026");
		expect(input).toHaveAttribute("placeholder", "mm/dd/yyyy");
	});

	it("passes up a typed day, an emptied field, and nothing for a wrong one", () => {
		const onChange = vi.fn();
		render(<Controlled kind="date" initial="" onChange={onChange} max="2026-12-31" />);
		const input = screen.getByLabelText("field");
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "5/3/2026" } });
		expect(onChange).toHaveBeenLastCalledWith("2026-03-05");
		// Still being typed: the text stays as the person wrote it.
		expect(input).toHaveValue("5/3/2026");
		fireEvent.blur(input);
		expect(input).toHaveValue("05/03/2026");

		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "31/02/2026" } });
		expect(input).toHaveAttribute("aria-invalid", "true");
		fireEvent.change(input, { target: { value: "01/01/2027" } });
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(onChange).toHaveBeenCalledTimes(1);
		fireEvent.blur(input);
		expect(input).toHaveValue("05/03/2026");
		expect(input).not.toHaveAttribute("aria-invalid");

		fireEvent.change(input, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith("");
	});

	it("picks a day from a calendar that starts on Monday", () => {
		const onChange = vi.fn();
		render(<Controlled kind="date" initial="2026-11-03" onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Ouvrir le calendrier" }));
		expect(screen.getByText("novembre 2026")).toBeInTheDocument();
		expect(screen.getByText("lun.")).toBeInTheDocument();
		const selected = screen.getByRole("button", { name: "mardi 3 novembre 2026" });
		expect(selected).toHaveAttribute("aria-pressed", "true");
		expect(selected).toHaveFocus();
		fireEvent.click(screen.getByRole("button", { name: "vendredi 20 novembre 2026" }));
		expect(onChange).toHaveBeenLastCalledWith("2026-11-20");
		expect(screen.queryByText("novembre 2026")).not.toBeInTheDocument();
		expect(screen.getByLabelText("field")).toHaveValue("20/11/2026");
	});

	it("moves between days with the arrows and between months with the buttons", () => {
		render(<Controlled kind="date" initial="2026-11-28" />);
		fireEvent.click(screen.getByRole("button", { name: "Ouvrir le calendrier" }));
		const start = screen.getByRole("button", { name: "samedi 28 novembre 2026" });
		fireEvent.keyDown(start, { key: "ArrowRight" });
		expect(screen.getByRole("button", { name: "dimanche 29 novembre 2026" })).toHaveFocus();
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
		expect(screen.getByText("décembre 2026")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "dimanche 6 décembre 2026" })).toHaveFocus();
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
		expect(screen.getByRole("button", { name: "samedi 28 novembre 2026" })).toHaveFocus();
		fireEvent.keyDown(document.activeElement as Element, { key: "a" });
		expect(screen.getByRole("button", { name: "samedi 28 novembre 2026" })).toHaveFocus();

		const next = screen.getByRole("button", { name: "Mois suivant" });
		fireEvent.click(next);
		expect(screen.getByText("décembre 2026")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Mois précédent" }));
		fireEvent.click(screen.getByRole("button", { name: "Mois précédent" }));
		expect(screen.getByText("octobre 2026")).toBeInTheDocument();
	});

	it("offers today and clearing, and refuses days out of bounds", () => {
		const onChange = vi.fn();
		render(<Controlled kind="date" initial="" onChange={onChange} min="2026-11-10" />);
		fireEvent.click(screen.getByRole("button", { name: "Ouvrir le calendrier" }));
		// No value: the calendar opens on today.
		expect(screen.getByRole("button", { name: "samedi 28 novembre 2026" })).toHaveFocus();
		expect(screen.getByRole("button", { name: "lundi 9 novembre 2026" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Aujourd'hui" }));
		expect(onChange).toHaveBeenLastCalledWith("2026-11-28");
		fireEvent.click(screen.getByRole("button", { name: "Ouvrir le calendrier" }));
		fireEvent.click(screen.getByRole("button", { name: "Effacer" }));
		expect(onChange).toHaveBeenLastCalledWith("");
	});

	it("keeps today out of reach when it lies outside the bounds, and starts on Sunday in English", async () => {
		await i18n.changeLanguage("en");
		render(<Controlled kind="date" initial="2026-10-05" max="2026-10-31" />);
		fireEvent.click(screen.getByRole("button", { name: "Open the calendar" }));
		expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
		expect(screen.getByText("Sun")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Monday, October 5, 2026" })).toHaveAttribute("aria-pressed", "true");
	});

	it("can be disabled", () => {
		render(<Controlled kind="date" initial="2026-11-03" disabled />);
		expect(screen.getByLabelText("field")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Ouvrir le calendrier" })).toBeDisabled();
	});
});

describe("MonthField", () => {
	it("names the month in the language and picks one from its year", () => {
		const onChange = vi.fn();
		render(<Controlled kind="month" initial="2025-06" onChange={onChange} max="2026-11" />);
		const trigger = screen.getByLabelText("field");
		expect(trigger).toHaveTextContent("juin 2025");
		fireEvent.click(trigger);
		expect(screen.getByText("2025")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "juin 2025" })).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: "Année suivante" }));
		expect(screen.getByRole("button", { name: "décembre 2026" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Année précédente" }));
		fireEvent.click(screen.getByRole("button", { name: "Année précédente" }));
		fireEvent.click(screen.getByRole("button", { name: "mars 2024" }));
		expect(onChange).toHaveBeenLastCalledWith("2024-03");
		expect(trigger).toHaveTextContent("mars 2024");
	});

	it("offers this month and clearing, and opens on this year when empty", async () => {
		const onChange = vi.fn();
		render(<Controlled kind="month" initial="" onChange={onChange} />);
		const trigger = screen.getByLabelText("field");
		expect(trigger).toHaveTextContent("Choisir un mois");
		fireEvent.click(trigger);
		expect(screen.getByText("2026")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Année précédente" }));
		fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
		// Reopened, it is back on this year.
		fireEvent.click(trigger);
		expect(screen.getByText("2026")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Ce mois-ci" }));
		expect(onChange).toHaveBeenLastCalledWith("2026-11");
		fireEvent.click(trigger);
		fireEvent.click(screen.getByRole("button", { name: "Effacer" }));
		expect(onChange).toHaveBeenLastCalledWith("");
	});

	it("keeps this month out of reach before the minimum", () => {
		render(<Controlled kind="month" initial="2027-02" min="2027-01" />);
		fireEvent.click(screen.getByLabelText("field"));
		expect(screen.getByRole("button", { name: "Ce mois-ci" })).toBeDisabled();
	});
});

describe("TimeField", () => {
	it("writes a 24-hour clock in French and keeps AM/PM in English", async () => {
		const { rerender } = render(<TimeField aria-label="field" value="14:30" onValueChange={vi.fn()} />);
		const input = screen.getByLabelText("field");
		expect(input).toHaveValue("14:30");
		expect(input).toHaveAttribute("placeholder", "hh:mm");
		await act(() => i18n.changeLanguage("en"));
		rerender(<TimeField aria-label="field" value="14:30" onValueChange={vi.fn()} />);
		expect(input).toHaveValue("02:30 PM");
	});

	it("reads a typed time and flags a wrong one", () => {
		const onChange = vi.fn();
		render(<Controlled kind="time" initial="" onChange={onChange} />);
		const input = screen.getByLabelText("field");
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "7h45" } });
		expect(onChange).toHaveBeenLastCalledWith("07:45");
		fireEvent.change(input, { target: { value: "27h" } });
		expect(input).toHaveAttribute("aria-invalid", "true");
		fireEvent.blur(input);
		expect(input).toHaveValue("07:45");
	});

	it("opens its list on the value's half hour and picks one", () => {
		const onChange = vi.fn();
		render(<Controlled kind="time" initial="14:40" onChange={onChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Afficher les heures" }));
		expect(screen.getByRole("button", { name: "14:30" })).toHaveFocus();
		fireEvent.click(screen.getByRole("button", { name: "18:00" }));
		expect(onChange).toHaveBeenLastCalledWith("18:00");
		expect(screen.getByLabelText("field")).toHaveValue("18:00");
		fireEvent.click(screen.getByRole("button", { name: "Afficher les heures" }));
		expect(screen.getByRole("button", { name: "18:00" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "18:00" })).toHaveFocus();
	});

	it("opens on nine o'clock without a value, and on the hour before half past", () => {
		const { unmount } = render(<Controlled kind="time" initial="" />);
		fireEvent.click(screen.getByRole("button", { name: "Afficher les heures" }));
		expect(screen.getByRole("button", { name: "09:00" })).toHaveFocus();
		unmount();
		render(<Controlled kind="time" initial="06:10" />);
		fireEvent.click(screen.getByRole("button", { name: "Afficher les heures" }));
		expect(screen.getByRole("button", { name: "06:00" })).toHaveFocus();
	});
});

describe("guard: no native date, time or month input in the renderer", () => {
	const rendererRoot = path.resolve(__dirname, "../../..");

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				return ["__tests__", "mocks", "node_modules"].includes(entry.name) ? [] : sourceFiles(full);
			}
			const isSource = /\.(ts|tsx)$/.test(entry.name);
			const isTest = /\.(test|spec)\.(ts|tsx)$/.test(entry.name);
			return isSource && !isTest ? [full] : [];
		});
	}

	// These draw their text with the OS region, whatever the app's language.
	const NATIVE = /type\s*[=:]\s*\{?\s*["'`](date|time|month|week|datetime-local)["'`]/;
	const COMMENT = /^\s*(\*|\/\/|\/\*)/;

	it("uses DateField, MonthField or TimeField instead", () => {
		const offenders = sourceFiles(rendererRoot).flatMap((file) =>
			readFileSync(file, "utf-8")
				.split("\n")
				.flatMap((line, index) =>
					NATIVE.test(line) && !COMMENT.test(line) ? [`${path.relative(rendererRoot, file)}:${index + 1}: ${line.trim()}`] : [],
				),
		);
		expect(offenders).toEqual([]);
	});

	it("would catch one", () => {
		expect(NATIVE.test('<Input type="date" value={x} />')).toBe(true);
		expect(NATIVE.test("<input type={'time'} />")).toBe(true);
		expect(NATIVE.test('{ type: "datetime-local" }')).toBe(true);
		expect(NATIVE.test('<Input type="text" />')).toBe(false);
	});
});
