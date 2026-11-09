import { describe, expect, it } from "vitest";
import enNavigation from "@shared/i18n/locales/en/navigation.json";
import frNavigation from "@shared/i18n/locales/fr/navigation.json";
import { EXPERIMENTAL_VIEWS } from "../experimental-views";
import { buildNavIndex } from "../nav-index";
import { githubNavItems, navGroups } from "../nav-model";

const ITEM_KEYS = Object.keys(enNavigation.items);

describe("the pages the command palette offers", () => {
	it("lists each page once, the tabs of a hub under the hub's name", () => {
		const entries = buildNavIndex(navGroups, { serverProject: false });
		const views = entries.map((e) => e.view);
		expect(new Set(views).size).toBe(views.length);
		const replay = entries.find((e) => e.view === "agent-replay");
		expect(replay?.placeKeys).toEqual(["navigation:groups.workspace", "navigation:hubs.agentHistory"]);
	});

	it("follows the gates of the menu: hidden beta views are not offered", () => {
		const entries = buildNavIndex(navGroups, { serverProject: false, hideExperimental: true });
		expect(entries.some((e) => EXPERIMENTAL_VIEWS.has(e.view))).toBe(false);
	});

	it("offers the forge entries only when the menu has them", () => {
		const without = buildNavIndex(navGroups, { serverProject: false });
		expect(without.some((e) => e.view === "github-prs")).toBe(false);
		const withForge = buildNavIndex(
			navGroups.map((g) => (g.id === "git-integrations" ? { ...g, items: [...g.items, ...githubNavItems] } : g)),
			{ serverProject: false },
		);
		expect(withForge.some((e) => e.view === "github-prs")).toBe(true);
	});

	it("has search keywords in English and French for the same pages", () => {
		expect(Object.keys(frNavigation.keywords).sort()).toEqual(Object.keys(enNavigation.keywords).sort());
		for (const key of Object.keys(enNavigation.keywords)) expect(ITEM_KEYS).toContain(key);
	});
});
