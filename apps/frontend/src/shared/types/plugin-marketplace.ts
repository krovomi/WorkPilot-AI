/**
 * Plugin Marketplace Types
 *
 * Types for the Plugin Marketplace — community-driven ecosystem for
 * extending WorkPilot AI with agents, integrations, templates, themes, and prompts.
 */

import type { LocalizedText } from "./mcp-marketplace";

/** Plugin type categories */
export type PluginType =
	| "agent"
	| "integration"
	| "spec-template"
	| "theme"
	| "custom-prompt";

/** Plugin sort options */
export type PluginSortBy = "featured" | "name";

/** Active tab in the marketplace */
export type PluginMarketplaceTab = "catalog" | "installed" | "sdk";

/** The types a catalog plugin can be: each one installs as a project skill. */
export type CatalogPluginType = "agent" | "spec-template" | "custom-prompt";

/** The skill a plugin installs. */
export interface PluginSkill {
	/** Frontmatter `description`: when an agent should use the skill */
	description: string;
	/** Markdown body of `SKILL.md` */
	body: string;
}

/**
 * A plugin of the catalog (`shared/plugin-catalog/plugins.json`). Installing
 * it writes its skill into the selected project, under `.agents/skills/<id>/`
 * (Agent Skills standard: Kanban slash commands, Codex, pi…) and the Claude
 * Code mirror `.claude/skills/<id>/`.
 */
export interface MarketplacePlugin {
	id: string;
	name: string;
	type: CatalogPluginType;
	author: string;
	color: string;
	tags: string[];
	tagline: LocalizedText;
	description: LocalizedText;
	skill: PluginSkill;
}

/** A catalog plugin found installed in a project. */
export interface InstalledPlugin {
	pluginId: string;
	name: string;
	type: CatalogPluginType;
	/** Folders it was written to, relative to the project */
	paths: string[];
}

/** Filter options for the marketplace catalog */
export interface PluginMarketplaceFilters {
	search: string;
	type: CatalogPluginType | "all";
	sortBy: PluginSortBy;
	showInstalledOnly: boolean;
}
