import { beforeEach, describe, expect, it } from "vitest";
import enNavigation from "@shared/i18n/locales/en/navigation.json";
import frNavigation from "@shared/i18n/locales/fr/navigation.json";
import { EXPERIMENTAL_VIEWS } from "../experimental-views";
import {
	entryIdOfView,
	forgetHubTabs,
	getHub,
	hubEntryTarget,
	hubOfView,
	isHubExperimental,
	rememberHubTab,
	SIDEBAR_HUBS,
	shownHubTabs,
} from "../hubs";

function label(resource: unknown, key: string): unknown {
	return key
		.replace(/^navigation:/, "")
		.split(".")
		.reduce<unknown>(
			(node, part) => (node as Record<string, unknown> | undefined)?.[part],
			resource,
		);
}

describe("sidebar hubs", () => {
	beforeEach(() => forgetHubTabs());

	it("puts each view in one hub at most, and gives each hub two tabs or more", () => {
		const views = SIDEBAR_HUBS.flatMap((hub) => hub.tabs.map((tab) => tab.view));
		expect(new Set(views).size).toBe(views.length);
		for (const hub of SIDEBAR_HUBS) expect(hub.tabs.length).toBeGreaterThan(1);
		expect(new Set(SIDEBAR_HUBS.map((hub) => hub.id)).size).toBe(SIDEBAR_HUBS.length);
	});

	it("opens on a page, not on a dialog", () => {
		for (const hub of SIDEBAR_HUBS) expect(hub.tabs[0].dialog).toBeUndefined();
	});

	it("names every hub, tab and dialog tab in English and French", () => {
		for (const resource of [enNavigation, frNavigation]) {
			for (const hub of SIDEBAR_HUBS) {
				expect(typeof label(resource, hub.labelKey), hub.labelKey).toBe("string");
				for (const tab of hub.tabs) {
					expect(typeof label(resource, tab.labelKey), tab.labelKey).toBe("string");
					if (tab.dialog) {
						const key = `hubs.launchers.${tab.view}`;
						expect(typeof label(resource, key), key).toBe("string");
					}
				}
			}
		}
	});

	it("keeps the old shortcuts, each once", () => {
		const shortcuts = SIDEBAR_HUBS.flatMap((hub) => hub.tabs.map((tab) => tab.shortcut)).filter(
			Boolean,
		);
		expect(new Set(shortcuts).size).toBe(shortcuts.length);
		expect(getHub("agent-history").tabs.map((tab) => tab.shortcut)).toEqual(["WS", "AR", "AG"]);
	});

	it("maps a view to its hub's entry, and any other view to itself", () => {
		expect(hubOfView("agent-replay")?.id).toBe("agent-history");
		expect(entryIdOfView("agent-replay")).toBe("session-history");
		expect(entryIdOfView("plugin-marketplace")).toBe("agent-tools");
		expect(hubOfView("kanban")).toBeUndefined();
		expect(entryIdOfView("kanban")).toBe("kanban");
	});

	it("shows a server project only the tabs the server offers", () => {
		const hub = getHub("agent-history");
		expect(shownHubTabs(hub, { serverProject: false }).map((t) => t.view)).toEqual([
			"session-history",
			"agent-replay",
			"agent-debugger",
		]);
		expect(shownHubTabs(hub, { serverProject: true }).map((t) => t.view)).toEqual([
			"session-history",
		]);
		expect(shownHubTabs(getHub("mcp-tools"), { serverProject: true })).toEqual([]);
	});

	it("hides experimental tabs when asked, except the one on screen", () => {
		const hub = getHub("agent-history");
		const gates = { serverProject: false, hideExperimental: true };
		expect(shownHubTabs(hub, gates).map((t) => t.view)).toEqual(["session-history"]);
		expect(shownHubTabs(hub, gates, "agent-replay").map((t) => t.view)).toEqual([
			"session-history",
			"agent-replay",
		]);
	});

	it("marks a hub experimental only when all its tabs are", () => {
		for (const hub of SIDEBAR_HUBS) {
			expect(isHubExperimental(hub)).toBe(
				hub.tabs.every((tab) => EXPERIMENTAL_VIEWS.has(tab.view)),
			);
		}
		expect(isHubExperimental(getHub("agent-history"))).toBe(false);
	});

	it("reopens the last tab of the session, if it is still shown", () => {
		const hub = getHub("agent-history");
		const local = { serverProject: false };
		expect(hubEntryTarget(hub, local)).toBe("session-history");
		rememberHubTab("agent-debugger");
		rememberHubTab("kanban");
		expect(hubEntryTarget(hub, local)).toBe("agent-debugger");
		expect(hubEntryTarget(getHub("docs"), local)).toBe("documentation");
		expect(hubEntryTarget(hub, { serverProject: true })).toBe("session-history");
		expect(hubEntryTarget(getHub("mcp-tools"), { serverProject: true })).toBeUndefined();
	});
});
