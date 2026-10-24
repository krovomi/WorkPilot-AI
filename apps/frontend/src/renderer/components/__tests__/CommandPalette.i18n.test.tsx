/**
 * The command palette speaks the user's language: every built-in command,
 * category and hint comes from `common:commandPalette`, in English and French.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import enCommon from "../../../shared/i18n/locales/en/common.json";
import frCommon from "../../../shared/i18n/locales/fr/common.json";
import { CommandPalette } from "../CommandPalette";

function renderPalette() {
	return render(
		<CommandPalette
			open
			onOpenChange={vi.fn()}
			onNavigate={vi.fn()}
			onNewTask={vi.fn()}
			onOpenSettings={vi.fn()}
			onOpenSettingsSection={vi.fn()}
			onToggleTheme={vi.fn()}
		/>,
	);
}

function keys(value: unknown, prefix = ""): string[] {
	if (typeof value !== "object" || value === null) return [prefix];
	return Object.entries(value).flatMap(([k, v]) =>
		keys(v, prefix ? `${prefix}.${k}` : k),
	);
}

describe("CommandPalette i18n", () => {
	afterEach(async () => {
		await act(() => i18n.changeLanguage("en"));
	});

	it("has the same keys in English and French", () => {
		expect(keys(frCommon.commandPalette).sort()).toEqual(
			keys(enCommon.commandPalette).sort(),
		);
	});

	it("shows French labels, categories and hints in French", async () => {
		await act(() => i18n.changeLanguage("fr"));
		renderPalette();

		expect(screen.getByText("Créer une tâche")).toBeTruthy();
		expect(screen.getByText("Aller au Kanban")).toBeTruthy();
		expect(screen.getByText("Réglages")).toBeTruthy();
		expect(
			screen.getByPlaceholderText("Tapez une commande ou cherchez…"),
		).toBeTruthy();
		expect(screen.queryByText("Create Task")).toBeNull();
	});

	it("finds a command by its translated label and counts the results", async () => {
		await act(() => i18n.changeLanguage("fr"));
		renderPalette();

		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "Nouveau terminal" },
		});
		expect(screen.getByText("Nouveau terminal")).toBeTruthy();
		expect(screen.getByText(/^\d+ commandes?$/)).toBeTruthy();
	});

	it("says when nothing matches", () => {
		renderPalette();
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "zzzzqqq" },
		});
		expect(screen.getByText('No commands found for "zzzzqqq"')).toBeTruthy();
	});
});
