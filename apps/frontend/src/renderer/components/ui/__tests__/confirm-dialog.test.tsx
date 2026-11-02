/**
 * confirmAction() remplace window.confirm : la promesse répond true sur
 * « Confirmer », false sur « Annuler », et une nouvelle demande annule la
 * précédente.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmDialogHost, confirmAction } from "../confirm-dialog";

function mountHost() {
	render(<ConfirmDialogHost />);
}

describe("confirmAction", () => {
	it("résout true quand l'utilisateur confirme", async () => {
		mountHost();
		let answer: Promise<boolean> = Promise.resolve(false);
		act(() => {
			answer = confirmAction({ title: "Supprimer le modèle ?", destructive: true });
		});
		expect(await screen.findByText("Supprimer le modèle ?")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /delete|buttons\.delete/i }));
		await expect(answer).resolves.toBe(true);
	});

	it("résout false quand l'utilisateur annule", async () => {
		mountHost();
		let answer: Promise<boolean> = Promise.resolve(true);
		act(() => {
			answer = confirmAction({ title: "Continuer ?" });
		});
		await screen.findByText("Continuer ?");
		fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
		await expect(answer).resolves.toBe(false);
	});

	it("une deuxième demande répond false à la première", async () => {
		mountHost();
		let first: Promise<boolean> = Promise.resolve(true);
		act(() => {
			first = confirmAction({ title: "Première" });
		});
		act(() => {
			void confirmAction({ title: "Seconde" });
		});
		await expect(first).resolves.toBe(false);
		expect(await screen.findByText("Seconde")).toBeTruthy();
	});
});
