/**
 * Rendu du DiffViewer : marqueurs +/- et classes git (vert/rouge) sur les
 * lignes, mots changés, séparateur de hunk avec les lignes masquées et la
 * portée, fichier ajouté en une colonne même en côte à côte, et commentaire
 * de ligne dans les deux dispositions.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiffViewer } from "../diff-viewer";

const MODIFIED = [
	"--- a/src/Order.cs",
	"+++ b/src/Order.cs",
	"@@ -12,3 +12,3 @@ public class Order",
	" {",
	"-    var total = amount * 2;",
	"+    var total = amount * rate;",
	" }",
].join("\n");

const ADDED = ["@@ -0,0 +1,2 @@", "+using Xunit;", "+namespace Tests;"].join("\n");

describe("DiffViewer", () => {
	it("signe et colore les lignes ajoutées et supprimées", () => {
		const { container } = render(<DiffViewer patch={MODIFIED} viewMode="unified" />);
		const added = container.querySelector('[data-line-type="added"]');
		const removed = container.querySelector('[data-line-type="removed"]');
		expect(added?.classList.contains("is-add")).toBe(true);
		expect(removed?.classList.contains("is-del")).toBe(true);
		expect(added?.querySelector(".dv-sign")?.textContent).toBe("+");
		expect(removed?.querySelector(".dv-sign")?.textContent).toBe("-");
		// Mot à mot : seul « rate » / « 2 » est marqué.
		expect(added?.querySelector(".dv-word-add")?.textContent).toBe("rate");
		expect(removed?.querySelector(".dv-word-del")?.textContent).toBe("2");
	});

	it("affiche les lignes masquées et la portée du hunk", () => {
		render(<DiffViewer patch={MODIFIED} viewMode="unified" />);
		expect(screen.getByText("11 unchanged lines")).toBeInTheDocument();
		expect(screen.getByText("@@ -12,3 +12,3 @@")).toBeInTheDocument();
		expect(screen.getByText("public class Order")).toBeInTheDocument();
	});

	it("met côte à côte un fichier modifié quand on le demande", () => {
		const { container } = render(<DiffViewer patch={MODIFIED} viewMode="split" />);
		expect(container.querySelector(".dv")?.getAttribute("data-layout")).toBe("split");
		const row = container.querySelector('[data-side="old"].is-del');
		expect(row?.parentElement?.querySelector('[data-side="new"].is-add')).not.toBeNull();
	});

	it("garde un fichier ajouté en une colonne, sans moitié vide", () => {
		const { container } = render(<DiffViewer patch={ADDED} viewMode="split" />);
		expect(container.querySelector(".dv")?.getAttribute("data-layout")).toBe("unified");
		expect(container.querySelector(".is-empty")).toBeNull();
	});

	it("commente une ligne supprimée côté ancien, en unifié comme en côte à côte", () => {
		for (const viewMode of ["unified", "split"] as const) {
			const onCommentLine = vi.fn();
			const { container, unmount } = render(
				<DiffViewer patch={MODIFIED} viewMode={viewMode} onCommentLine={onCommentLine} />,
			);
			const removed = container.querySelector('[data-line-type="removed"]');
			const button = removed?.querySelector("button");
			expect(button?.getAttribute("aria-label")).toBe("Comment on line 13");
			if (button) fireEvent.click(button);
			expect(onCommentLine).toHaveBeenCalledWith({ side: "old", line: 13 });
			// Une ligne de contexte n'a qu'un bouton, même côte à côte.
			expect(
				screen.getAllByRole("button", { name: "Comment on line 12" }),
			).toHaveLength(1);
			unmount();
		}
	});

	it("dit qu'il n'y a pas de contenu pour un patch vide", () => {
		render(<DiffViewer patch="" />);
		expect(screen.getByText("No diff content available for this file")).toBeInTheDocument();
	});
});
