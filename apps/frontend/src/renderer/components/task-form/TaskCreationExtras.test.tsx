/**
 * @vitest-environment jsdom
 */
/**
 * Acceptance criteria and the extra note can be written while creating a
 * task, not only after it exists.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

import {
	type CriterionDraft,
	ensureAtLeastOne,
	toCriteria,
} from "../task-detail/acceptance-criteria-draft";
import { TaskCreationExtras } from "./TaskCreationExtras";

function Harness() {
	const [criteria, setCriteria] = useState<CriterionDraft[]>(() =>
		ensureAtLeastOne([]),
	);
	const [note, setNote] = useState("");
	return (
		<>
			<TaskCreationExtras
				criteria={criteria}
				onCriteriaChange={setCriteria}
				extraNote={note}
				onExtraNoteChange={setNote}
			/>
			<output data-testid="criteria">{toCriteria(criteria).join(" | ")}</output>
			<output data-testid="note">{note}</output>
		</>
	);
}

describe("TaskCreationExtras", () => {
	it("collects acceptance criteria as bullets and an extra note", () => {
		render(<Harness />);

		fireEvent.click(screen.getByRole("button", { name: /acceptance criteria/i }));
		const [first] = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
		fireEvent.paste(first, {
			clipboardData: { getData: () => "- Invoice is created\n- Mail is sent" },
		});
		expect(screen.getByTestId("criteria")).toHaveTextContent(
			"Invoice is created | Mail is sent",
		);

		fireEvent.click(screen.getByRole("button", { name: /additional note/i }));
		fireEvent.change(screen.getByLabelText(/additional note/i, { selector: "textarea" }), {
			target: { value: "Keep the public API unchanged" },
		});
		expect(screen.getByTestId("note")).toHaveTextContent(
			"Keep the public API unchanged",
		);
	});

	it("keeps what was typed in text mode when switching back to bullets", () => {
		render(<Harness />);
		fireEvent.click(screen.getByRole("button", { name: /acceptance criteria/i }));
		fireEvent.click(screen.getByRole("button", { name: "Text" }));
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "First\nSecond" },
		});
		expect(screen.getByTestId("criteria")).toHaveTextContent("First | Second");
		fireEvent.click(screen.getByRole("button", { name: "Bullets" }));
		expect(
			(screen.getAllByRole("textbox") as HTMLTextAreaElement[]).map((el) => el.value),
		).toEqual(["First", "Second"]);
	});
});
