import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppSettingsDialog } from "./AppSettings";

/**
 * La barre de filtre de la navigation des paramètres — le pendant de celle du
 * menu principal. Le tri et la correspondance sont couverts unitairement dans
 * `settings-search.test.ts` ; ici on vérifie ce que le composant en fait.
 */

/** Le nom accessible du bouton loupe et du champ est le même libellé. */
const SEARCH_LABEL = /rechercher un paramètre|search settings/i;

/** Le dialogue est piloté par le parent : ici il reste ouvert quoi qu'il arrive. */
function noop() {
	// Intentionally empty for tests
}

function renderSettings() {
	return render(<AppSettingsDialog open onOpenChange={noop} />);
}

/** La navigation, pour ne pas confondre ses libellés avec ceux du panneau. */
function nav() {
	return screen.getByRole("navigation");
}

async function openFilter(user: ReturnType<typeof userEvent.setup>) {
	await user.click(within(nav()).getByRole("button", { name: SEARCH_LABEL }));
	return within(nav()).getByRole("textbox", { name: SEARCH_LABEL });
}

describe("AppSettings — barre de filtre", () => {
	it("n'affiche qu'un bouton tant que le filtre n'est pas ouvert", () => {
		renderSettings();
		expect(
			within(nav()).getByRole("button", { name: SEARCH_LABEL }),
		).toBeInTheDocument();
		expect(
			within(nav()).queryByRole("textbox", { name: SEARCH_LABEL }),
		).not.toBeInTheDocument();
	});

	it("ne garde que les sections qui correspondent", async () => {
		const user = userEvent.setup();
		renderSettings();
		const input = await openFilter(user);

		expect(within(nav()).getByText("Langue")).toBeInTheDocument();

		await user.type(input, "affich");

		expect(within(nav()).getByText("Affichage")).toBeInTheDocument();
		expect(within(nav()).queryByText("Langue")).not.toBeInTheDocument();
		expect(within(nav()).queryByText("Debug")).not.toBeInTheDocument();
	});

	it("trouve un libellé accentué tapé sans ses accents", async () => {
		const user = userEvent.setup();
		renderSettings();
		const input = await openFilter(user);

		await user.type(input, "general");

		expect(within(nav()).getByText("Général")).toBeInTheDocument();
	});

	it("annonce qu'aucun paramètre ne correspond", async () => {
		const user = userEvent.setup();
		renderSettings();
		const input = await openFilter(user);

		await user.type(input, "zzzzz");

		expect(
			within(nav()).getByText(/aucun paramètre trouvé|no settings found/i),
		).toBeInTheDocument();
	});

	it("rend toute la navigation quand le filtre est vidé", async () => {
		const user = userEvent.setup();
		renderSettings();
		const input = await openFilter(user);

		await user.type(input, "affich");
		expect(within(nav()).queryByText("Langue")).not.toBeInTheDocument();

		await user.click(
			within(nav()).getByRole("button", {
				name: /effacer la recherche|clear search/i,
			}),
		);

		expect(within(nav()).getByText("Langue")).toBeInTheDocument();
	});

	it("garde les paramètres ouverts quand Échap vide le filtre", async () => {
		const user = userEvent.setup();
		const { container } = renderSettings();
		const input = await openFilter(user);

		await user.type(input, "affich");
		await user.keyboard("{Escape}");

		// Le dialogue est toujours là, et la navigation est revenue entière.
		expect(screen.getByRole("navigation")).toBeInTheDocument();
		expect(within(nav()).getByText("Langue")).toBeInTheDocument();
		expect(container).toBeTruthy();
	});
});
