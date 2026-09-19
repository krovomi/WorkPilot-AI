/**
 * @vitest-environment jsdom
 */
/**
 * Tests AcceptanceCriteriaEditor — les critères d'acceptation en puces.
 *
 * Ce que l'éditeur ajoute au textarea qu'il remplace, c'est l'identité d'une
 * ligne : on peut la supprimer, la déplacer, lui donner le focus. Ces tests
 * fixent ces trois gestes, plus celui par lequel les critères arrivent
 * réellement — un collage depuis un ticket.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import "@testing-library/jest-dom";
import "../../../shared/i18n";

import { AcceptanceCriteriaEditor } from "./AcceptanceCriteriaEditor";
import {
	type CriterionDraft,
	toCriteria,
	toDrafts,
} from "./acceptance-criteria-draft";

/** L'éditeur est contrôlé : le harnais tient l'état comme la section le fait. */
function Harness({ initial }: { readonly initial: string[] }) {
	const [drafts, setDrafts] = useState<CriterionDraft[]>(() =>
		toDrafts(initial),
	);
	return (
		<>
			<AcceptanceCriteriaEditor drafts={drafts} onChange={setDrafts} />
			<output data-testid="saved">{toCriteria(drafts).join(" | ")}</output>
		</>
	);
}

function bullets(): HTMLTextAreaElement[] {
	return screen.getAllByRole("textbox") as HTMLTextAreaElement[];
}

function saved(): string {
	return screen.getByTestId("saved").textContent ?? "";
}

describe("AcceptanceCriteriaEditor", () => {
	it("renders one input per criterion", () => {
		render(<Harness initial={["le login échoue", "le mot de passe expire"]} />);
		expect(bullets().map((b) => b.value)).toEqual([
			"le login échoue",
			"le mot de passe expire",
		]);
	});

	it("adds a bullet below on Enter and focuses it", () => {
		render(<Harness initial={["premier"]} />);
		fireEvent.keyDown(bullets()[0], { key: "Enter" });

		const inputs = bullets();
		expect(inputs).toHaveLength(2);
		expect(inputs[1].value).toBe("");
		expect(document.activeElement).toBe(inputs[1]);
		// Une puce vide n'est pas un critère : elle ne part pas à l'enregistrement.
		expect(saved()).toBe("premier");
	});

	it("never writes a newline inside a criterion", () => {
		render(<Harness initial={["premier"]} />);
		const event = fireEvent.keyDown(bullets()[0], { key: "Enter" });
		// fireEvent renvoie false quand le handler a appelé preventDefault.
		expect(event).toBe(false);
	});

	it("removes a bullet with its button and keeps the others", () => {
		render(<Harness initial={["un", "deux", "trois"]} />);
		fireEvent.click(screen.getByRole("button", { name: /2/ }));
		expect(bullets().map((b) => b.value)).toEqual(["un", "trois"]);
		expect(saved()).toBe("un | trois");
	});

	it("removes an emptied bullet on Backspace and goes back up", () => {
		render(<Harness initial={["un", ""]} />);
		const second = bullets()[1];
		second.setSelectionRange(0, 0);
		fireEvent.keyDown(second, { key: "Backspace" });

		const inputs = bullets();
		expect(inputs).toHaveLength(1);
		expect(document.activeElement).toBe(inputs[0]);
	});

	it("keeps the last bullet, so there is always somewhere to type", () => {
		render(<Harness initial={[""]} />);
		fireEvent.keyDown(bullets()[0], { key: "Backspace" });
		expect(bullets()).toHaveLength(1);
	});

	it("leaves an empty bullet when the last one is removed", () => {
		render(<Harness initial={["seul"]} />);
		fireEvent.click(screen.getByRole("button", { name: /1/ }));
		// Une liste sans champ n'offre nulle part où taper ; la puce vide, elle,
		// ne part pas à l'enregistrement.
		expect(bullets()).toHaveLength(1);
		expect(bullets()[0].value).toBe("");
		expect(saved()).toBe("");
	});

	it("reorders with Alt+Arrow and keeps the moved line focused", () => {
		render(<Harness initial={["un", "deux"]} />);
		fireEvent.keyDown(bullets()[1], { key: "ArrowUp", altKey: true });

		const inputs = bullets();
		expect(inputs.map((b) => b.value)).toEqual(["deux", "un"]);
		expect(document.activeElement).toBe(inputs[0]);
		expect(saved()).toBe("deux | un");
	});

	it("does nothing when the first line is moved up", () => {
		render(<Harness initial={["un", "deux"]} />);
		fireEvent.keyDown(bullets()[0], { key: "ArrowUp", altKey: true });
		expect(saved()).toBe("un | deux");
	});

	it("splits a pasted block into one bullet per line", () => {
		render(<Harness initial={[""]} />);
		fireEvent.paste(bullets()[0], {
			clipboardData: {
				getData: () => "- le login échoue\n- le mot de passe expire\n3. et puis",
			},
		});

		expect(bullets().map((b) => b.value)).toEqual([
			"le login échoue",
			"le mot de passe expire",
			"et puis",
		]);
	});

	it("leaves a single-line paste to the browser", () => {
		render(<Harness initial={["un"]} />);
		const event = fireEvent.paste(bullets()[0], {
			clipboardData: { getData: () => "collé" },
		});
		// Pas de preventDefault : c'est l'insertion native qu'on veut, avec son
		// curseur et son annulation.
		expect(event).toBe(true);
		expect(bullets()).toHaveLength(1);
	});

	it("adds a bullet from the button", () => {
		render(<Harness initial={["un"]} />);
		fireEvent.click(screen.getByRole("button", { name: /ajouter|add/i }));
		expect(bullets()).toHaveLength(2);
	});
});
