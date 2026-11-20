/**
 * The Plugin Marketplace: the catalog (searched, filtered, sorted, each card
 * installs into or removes from the selected project), the plugins the
 * selected project has, and the SDK page that opens the creator. A read that
 * fails is shown, and the plugins of the previous project are never offered
 * for removal in the next one.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { InstalledPlugin, MarketplacePlugin } from "../../../../shared/types/plugin-marketplace";
import { usePluginMarketplaceStore } from "../../../stores/plugin-marketplace-store";
import { useProjectStore } from "../../../stores/project-store";
import { PluginMarketplace } from "../PluginMarketplace";

const LONG =
	"Reads every change of the diff, flags risky patterns, missing tests and unclear names, then writes a short review the team can act on right away.";

function plugin(over: Partial<MarketplacePlugin>): MarketplacePlugin {
	return {
		id: "p",
		name: "Plugin",
		type: "agent",
		author: "Ada",
		color: "#8b5cf6",
		tags: [],
		tagline: { en: "A plugin", fr: "Un plugin" },
		description: { en: "Short.", fr: "Court." },
		skill: { description: "when", body: "# Skill body" },
		...over,
	};
}

const REVIEWER = plugin({
	id: "reviewer",
	name: "Reviewer",
	tagline: { en: "Reviews your diff", fr: "Relit votre diff" },
	description: { en: LONG, fr: LONG },
	tags: ["quality", "review", "git", "ci"],
	skill: { description: "review", body: "# Review the diff" },
});
const API_SPEC = plugin({
	id: "api-spec",
	name: "API spec",
	type: "spec-template",
	tags: ["openapi"],
});
const COMMIT = plugin({ id: "commit", name: "Commit message", type: "custom-prompt" });
const CATALOG = [REVIEWER, API_SPEC, COMMIT];

const installed = (id: string, type: InstalledPlugin["type"] = "agent"): InstalledPlugin => ({
	pluginId: id,
	name: id === "reviewer" ? "Reviewer" : id,
	type,
	paths: [`.agents/skills/${id}`, `.claude/skills/${id}`],
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** The skills each project has, as the main process reads them. */
let skills: Record<string, InstalledPlugin[]>;
const invoke = vi.fn();
const INITIAL = usePluginMarketplaceStore.getState();

function answer(channel: string, payload?: { projectId: string; pluginId: string }) {
	switch (channel) {
		case "pluginMarketplace:getCatalog":
			return Promise.resolve({ success: true, data: CATALOG });
		case "pluginMarketplace:getInstalled":
			return Promise.resolve({ success: true, data: [...(skills[payload?.projectId ?? ""] ?? [])] });
		case "pluginMarketplace:install": {
			const p = CATALOG.find((c) => c.id === payload?.pluginId) as MarketplacePlugin;
			skills[payload?.projectId ?? ""] = [...(skills[payload?.projectId ?? ""] ?? []), installed(p.id, p.type)];
			return Promise.resolve({ success: true });
		}
		case "pluginMarketplace:uninstall":
			skills[payload?.projectId ?? ""] = (skills[payload?.projectId ?? ""] ?? []).filter(
				(s) => s.pluginId !== payload?.pluginId,
			);
			return Promise.resolve({ success: true });
		default:
			return Promise.resolve({ success: false });
	}
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	usePluginMarketplaceStore.setState(INITIAL, true);
	useProjectStore.setState({ selectedProjectId: "shop" });
	skills = { shop: [installed("reviewer")] };
	invoke.mockReset().mockImplementation(answer);
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { invoke };
});

async function renderMarketplace() {
	const view = render(<PluginMarketplace />);
	// Let the catalog and installed reads answer.
	await act(async () => {
		await Promise.resolve();
	});
	return view;
}

const card = (name: string) => screen.getByRole("heading", { name }).closest(".wp-card") as HTMLElement;

describe("PluginMarketplace catalog", () => {
	it("lists the catalog with what the selected project already has", async () => {
		await renderMarketplace();
		expect(invoke).toHaveBeenCalledWith("pluginMarketplace:getCatalog");
		expect(invoke).toHaveBeenCalledWith("pluginMarketplace:getInstalled", { projectId: "shop" });

		expect(screen.getByRole("heading", { name: "Plugin Marketplace" })).toBeInTheDocument();
		expect(screen.getAllByText("1 installed").length).toBeGreaterThan(0);
		expect(screen.getByRole("tab", { name: /Installed/ })).toHaveTextContent("1");
		expect(screen.getByText("3 plugins")).toBeInTheDocument();

		const reviewer = within(card("Reviewer"));
		expect(reviewer.getByText("Reviews your diff")).toBeInTheDocument();
		expect(reviewer.getByText("Agent")).toBeInTheDocument();
		expect(reviewer.getByText("by Ada")).toBeInTheDocument();
		expect(reviewer.getByText("+1")).toBeInTheDocument();
		expect(reviewer.queryByText("ci")).not.toBeInTheDocument();
		expect(
			reviewer.getByText("Run it with /reviewer in the Kanban command bar, or let the agent pick it up."),
		).toBeInTheDocument();
		expect(reviewer.getByRole("button", { name: "Uninstall" })).toBeInTheDocument();

		expect(within(card("API spec")).getByText("Spec Template")).toBeInTheDocument();
		expect(within(card("Commit message")).getByText("Custom Prompt")).toBeInTheDocument();
		expect(within(card("Commit message")).getByRole("button", { name: "Install" })).toBeEnabled();
		expect(screen.queryByText("Select a project: plugins are installed into a project's skills.")).toBeNull();
	});

	it("installs a plugin into the selected project and removes one", async () => {
		await renderMarketplace();
		const pending = deferred<unknown>();
		invoke.mockImplementationOnce(() => pending.promise);
		fireEvent.click(within(card("Commit message")).getByRole("button", { name: "Install" }));
		expect(invoke).toHaveBeenLastCalledWith("pluginMarketplace:install", {
			projectId: "shop",
			pluginId: "commit",
		});
		expect(within(card("Commit message")).getByRole("button", { name: "Installing..." })).toBeDisabled();
		await act(async () => {
			skills.shop.push(installed("commit", "custom-prompt"));
			pending.resolve({ success: true });
		});
		expect(within(card("Commit message")).getByRole("button", { name: "Uninstall" })).toBeInTheDocument();
		expect(screen.getByRole("tab", { name: /Installed/ })).toHaveTextContent("2");

		await act(async () => {
			fireEvent.click(within(card("Reviewer")).getByRole("button", { name: "Uninstall" }));
		});
		expect(invoke).toHaveBeenCalledWith("pluginMarketplace:uninstall", {
			projectId: "shop",
			pluginId: "reviewer",
		});
		expect(within(card("Reviewer")).getByRole("button", { name: "Install" })).toBeInTheDocument();
	});

	it("shows why an install failed", async () => {
		await renderMarketplace();
		invoke.mockResolvedValueOnce({ success: false });
		await act(async () => {
			fireEvent.click(within(card("API spec")).getByRole("button", { name: "Install" }));
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Installation failed");
	});

	it("searches, filters by type and sorts by name", async () => {
		await renderMarketplace();
		const names = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
		expect(names()).toEqual(["Reviewer", "API spec", "Commit message"]);

		fireEvent.change(screen.getByRole("combobox", { name: "Sort plugins" }), {
			target: { value: "name" },
		});
		expect(names()).toEqual(["API spec", "Commit message", "Reviewer"]);

		const pill = screen.getByRole("button", { name: "Spec Template" });
		fireEvent.click(pill);
		expect(pill).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
		expect(names()).toEqual(["API spec"]);
		expect(screen.getByText("1 plugins")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "All" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Search plugins..." }), {
			target: { value: "diff" },
		});
		expect(names()).toEqual(["Reviewer"]);

		fireEvent.change(screen.getByRole("textbox", { name: "Search plugins..." }), {
			target: { value: "nothing like it" },
		});
		expect(screen.getByText("No plugins match your search")).toBeInTheDocument();
	});

	it("unfolds a long description and the skill a plugin installs", async () => {
		await renderMarketplace();
		const reviewer = within(card("Reviewer"));
		const more = reviewer.getByRole("button", { name: "Show more" });
		expect(more).toHaveAttribute("aria-expanded", "false");
		fireEvent.click(more);
		expect(reviewer.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
		fireEvent.click(reviewer.getByRole("button", { name: "Show less" }));
		expect(reviewer.getByRole("button", { name: "Show more" })).toBeInTheDocument();
		// A short description has nothing to unfold.
		expect(within(card("API spec")).queryByRole("button", { name: "Show more" })).toBeNull();

		fireEvent.click(reviewer.getByRole("button", { name: "Show the skill" }));
		expect(reviewer.getByText("# Review the diff")).toBeInTheDocument();
		fireEvent.click(reviewer.getByRole("button", { name: "Hide the skill" }));
		expect(reviewer.queryByText("# Review the diff")).toBeNull();
	});

	it("shows the description in the app's language", async () => {
		await i18n.changeLanguage("fr");
		await renderMarketplace();
		expect(screen.getByText("Relit votre diff")).toBeInTheDocument();
	});

	it("asks for a project before installing", async () => {
		useProjectStore.setState({ selectedProjectId: null });
		await renderMarketplace();
		expect(invoke).not.toHaveBeenCalledWith("pluginMarketplace:getInstalled", expect.anything());
		expect(screen.getByText("Select a project: plugins are installed into a project's skills.")).toBeInTheDocument();
		const install = within(card("Reviewer")).getByRole("button", { name: "Install" });
		expect(install).toBeDisabled();
		expect(install).toHaveAttribute("title", "Select a project: plugins are installed into a project's skills.");
		expect(screen.queryByText("1 installed")).toBeNull();
	});

	it("shows a spinner while the catalog loads, then why it could not be read", async () => {
		const pending = deferred<unknown>();
		invoke.mockImplementation((channel: string, payload) =>
			channel === "pluginMarketplace:getCatalog" ? pending.promise : answer(channel, payload),
		);
		await renderMarketplace();
		expect(screen.getByRole("status", { name: "Loading plugins" })).toBeInTheDocument();
		await act(async () => {
			pending.resolve(undefined);
		});
		expect(screen.getByRole("alert")).toHaveTextContent("Failed to load catalog");
		expect(screen.getByText("No plugins match your search")).toBeInTheDocument();
	});

	it("never offers to remove, in the next project, a plugin of the previous one", async () => {
		await renderMarketplace();
		expect(within(card("Reviewer")).getByRole("button", { name: "Uninstall" })).toBeInTheDocument();

		const office = deferred<unknown>();
		invoke.mockImplementationOnce(() => office.promise);
		await act(async () => {
			useProjectStore.setState({ selectedProjectId: "office" });
		});
		expect(within(card("Reviewer")).getByRole("button", { name: "Install" })).toBeEnabled();
		await act(async () => {
			office.resolve({ success: true, data: [] });
		});
		expect(within(card("Reviewer")).getByRole("button", { name: "Install" })).toBeInTheDocument();
	});
});

describe("PluginMarketplace installed tab", () => {
	const openInstalled = () => fireEvent.click(screen.getByRole("tab", { name: /Installed/ }));

	it("lists the project's plugins, where they live, and removes one", async () => {
		await renderMarketplace();
		openInstalled();
		expect(screen.getByText("1 plugins installed")).toBeInTheDocument();
		expect(screen.getByText("Reviewer")).toBeInTheDocument();
		expect(screen.getByText("Agent")).toBeInTheDocument();
		expect(screen.getByText("In .agents/skills/reviewer, .claude/skills/reviewer")).toBeInTheDocument();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Uninstall Reviewer" }));
		});
		expect(invoke).toHaveBeenCalledWith("pluginMarketplace:uninstall", {
			projectId: "shop",
			pluginId: "reviewer",
		});
		expect(screen.getByText("No plugins installed yet")).toBeInTheDocument();
		expect(
			screen.getByText("Browse the catalog to install your first plugin into this project"),
		).toBeInTheDocument();
	});

	it("names each type of installed plugin", async () => {
		skills.shop = [installed("api-spec", "spec-template"), installed("commit", "custom-prompt")];
		await renderMarketplace();
		openInstalled();
		expect(screen.getByText("Spec Template")).toBeInTheDocument();
		expect(screen.getByText("Custom Prompt")).toBeInTheDocument();
	});

	it("asks for a project when none is selected", async () => {
		useProjectStore.setState({ selectedProjectId: null });
		await renderMarketplace();
		openInstalled();
		expect(screen.getByText("Select a project: plugins are installed into a project's skills.")).toBeInTheDocument();
		expect(screen.queryByText("Browse the catalog to install your first plugin into this project")).toBeNull();
	});

	it("shows a spinner while it reads, and the answer of the last project picked", async () => {
		const shop = deferred<unknown>();
		const office = deferred<unknown>();
		invoke.mockImplementation((channel: string, payload: { projectId: string }) => {
			if (channel !== "pluginMarketplace:getInstalled") return answer(channel);
			return payload.projectId === "shop" ? shop.promise : office.promise;
		});
		await renderMarketplace();
		openInstalled();
		expect(screen.getByRole("status", { name: "Loading plugins" })).toBeInTheDocument();

		await act(async () => {
			useProjectStore.setState({ selectedProjectId: "office" });
		});
		await act(async () => {
			office.resolve({ success: true, data: [installed("commit", "custom-prompt")] });
		});
		await act(async () => {
			shop.resolve({ success: true, data: [installed("reviewer")] });
		});
		expect(screen.getByText("commit")).toBeInTheDocument();
		expect(screen.queryByText("Reviewer")).toBeNull();
	});

	it("shows why the project's plugins could not be read", async () => {
		invoke.mockImplementation((channel: string, payload) =>
			channel === "pluginMarketplace:getInstalled"
				? Promise.resolve({ success: false, error: "Unknown project" })
				: answer(channel, payload),
		);
		await renderMarketplace();
		expect(screen.getByRole("alert")).toHaveTextContent("Unknown project");
		openInstalled();
		expect(screen.getByText("No plugins installed yet")).toBeInTheDocument();
	});
});

describe("PluginMarketplace SDK tab", () => {
	it("documents the plugin types and opens the creator", async () => {
		await renderMarketplace();
		fireEvent.click(screen.getByRole("tab", { name: /Build a Plugin/ }));
		expect(screen.getByRole("heading", { name: "Plugin SDK" })).toBeInTheDocument();
		for (const title of ["Getting Started", "Plugin Structure", "Publishing to Marketplace", "Testing Locally"]) {
			expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
		}
		expect(screen.getByText("Available Plugin Types")).toBeInTheDocument();
		expect(screen.getByText("Custom UI color themes and visual styling")).toBeInTheDocument();
		expect(screen.getByText("spec-template", { selector: "code" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Create a Plugin" }));
		expect(screen.getByRole("heading", { name: "Create a Plugin" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.getByRole("heading", { name: "Plugin SDK" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("tab", { name: /Catalog/ }));
		expect(screen.getByText("3 plugins")).toBeInTheDocument();
	});
});
