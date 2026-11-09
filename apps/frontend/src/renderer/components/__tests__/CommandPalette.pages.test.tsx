/**
 * The palette lists every page of the menu (`sidebar/nav-index.ts`), not a
 * hand-written subset: found by name, by where it sits in the menu or by a
 * keyword, accents or not; the pages opened last come first; a tool that is a
 * dialog opens its dialog.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../shared/i18n";
import { useTestGenerationStore } from "../../stores/test-generation-store";
import { useViewUsageStore } from "../../stores/view-usage-store";
import { CommandPalette } from "../CommandPalette";
import { buildNavIndex, useNavIndexStore } from "../sidebar/nav-index";
import { navGroups } from "../sidebar/nav-model";

function renderPalette(onNavigate = vi.fn()) {
	render(
		<CommandPalette
			open
			onOpenChange={vi.fn()}
			onNavigate={onNavigate}
			onNewTask={vi.fn()}
			onOpenSettings={vi.fn()}
		/>,
	);
	return onNavigate;
}

function search(text: string) {
	fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

describe("CommandPalette pages", () => {
	beforeEach(async () => {
		useNavIndexStore.setState({
			entries: buildNavIndex(navGroups, { serverProject: false }),
		});
		useViewUsageStore.setState({ usage: {} });
		await act(() => i18n.changeLanguage("fr"));
	});
	afterEach(async () => {
		await act(() => i18n.changeLanguage("en"));
	});

	it("offers every page the menu shows, hub tabs included", () => {
		const views = useNavIndexStore.getState().entries.map((e) => e.view);
		expect(views.length).toBeGreaterThan(70);
		expect(views).toEqual(expect.arrayContaining(["kanban", "agent-replay", "flaky-tests", "offline-mode"]));
	});

	it("finds pages by a keyword, without accents", () => {
		renderPalette();
		search("securite");
		expect(screen.getByText("Garde d'injection")).toBeTruthy();
		expect(screen.getByText("Sentinelle de dépendances")).toBeTruthy();
	});

	it("finds every page about tests", () => {
		renderPalette();
		search("tests");
		expect(screen.getByText("Génération de tests")).toBeTruthy();
		expect(screen.getByText("Tests instables")).toBeTruthy();
		expect(screen.getByText("Gardien de régression")).toBeTruthy();
	});

	it("says where a page sits in the menu, and marks a beta page", () => {
		renderPalette();
		search("Traduction de code");
		expect(screen.getByText("Développement · bêta")).toBeTruthy();
	});

	it("opens a page through onNavigate", () => {
		const onNavigate = renderPalette();
		search("Feuille de route");
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		return new Promise<void>((resolve) =>
			requestAnimationFrame(() => {
				expect(onNavigate).toHaveBeenCalledWith("roadmap");
				resolve();
			}),
		);
	});

	it("opens a tool's dialog instead of a page", () => {
		const onNavigate = renderPalette();
		search("Génération de tests");
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
		return new Promise<void>((resolve) =>
			requestAnimationFrame(() => {
				expect(onNavigate).not.toHaveBeenCalled();
				expect(useTestGenerationStore.getState().isOpen).toBe(true);
				resolve();
			}),
		);
	});

	it("lists the pages opened last first, before any search", () => {
		useViewUsageStore.setState({
			usage: {
				roadmap: { visits: 1, dwellMs: 0, lastVisitedAt: 100 },
				worktrees: { visits: 1, dwellMs: 0, lastVisitedAt: 200 },
			},
		});
		renderPalette();
		const recent = screen.getByText("Récents");
		const list = recent.parentElement as HTMLElement;
		const labels = [...list.querySelectorAll("[data-command-item] .font-medium")].map((n) => n.textContent);
		expect(labels).toEqual(["Arbres de travail", "Feuille de route"]);
	});
});
