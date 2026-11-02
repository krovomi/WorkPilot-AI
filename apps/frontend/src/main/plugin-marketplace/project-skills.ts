/**
 * Plugin Marketplace → project skills.
 *
 * A catalog plugin is a skill (Agent Skills standard). Installing it writes
 * `<project>/.agents/skills/<id>/SKILL.md`, the source WorkPilot reads (Kanban
 * slash commands on every provider, pi, workflows) and the one Codex reads,
 * plus the Claude Code mirror `<project>/.claude/skills/<id>/SKILL.md`.
 *
 * The frontmatter carries `metadata.workpilot.plugin: <id>`. Only a folder with
 * that marker counts as installed and only such a folder is ever removed: a
 * skill the user or a pack wrote under the same name is left alone, and
 * installing over it is refused.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import catalogFile from "../../shared/plugin-catalog/plugins.json";
import type {
	InstalledPlugin,
	MarketplacePlugin,
} from "../../shared/types/plugin-marketplace";

/** Where a plugin's skill is written, relative to the project root. */
export const SKILL_ROOTS = [
	path.join(".agents", "skills"),
	path.join(".claude", "skills"),
] as const;

/** A skill name (Agent Skills): lowercase letters, digits and hyphens. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function loadPluginCatalog(): MarketplacePlugin[] {
	return (catalogFile as { plugins: MarketplacePlugin[] }).plugins;
}

/** The line that marks a skill as written by the marketplace for `id`. */
function marker(id: string): string {
	return `    plugin: ${id}`;
}

/** The `SKILL.md` the plugin installs. */
export function renderPluginSkill(plugin: MarketplacePlugin): string {
	// JSON strings are valid YAML double-quoted scalars.
	return [
		"---",
		`name: ${plugin.id}`,
		`description: ${JSON.stringify(plugin.skill.description)}`,
		"metadata:",
		"  workpilot:",
		marker(plugin.id),
		`    plugin-type: ${plugin.type}`,
		"---",
		"",
		plugin.skill.body.trimEnd(),
		"",
	].join("\n");
}

/** The project's root, resolved; throws when it is not a directory. */
function projectRoot(projectPath: string): string {
	const root = fs.realpathSync(projectPath);
	if (!fs.statSync(root).isDirectory()) {
		throw new Error("Project folder not found");
	}
	return root;
}

/**
 * `relative` resolved inside `root`, through any symbolic link on the way, or
 * `null` when it would leave the project.
 */
function insideProject(root: string, relative: string): string | null {
	let probe = path.join(root, relative);
	const rest: string[] = [];
	// Resolve the deepest part that exists, then append the rest.
	while (!fs.existsSync(probe)) {
		rest.unshift(path.basename(probe));
		const parent = path.dirname(probe);
		if (parent === probe) return null;
		probe = parent;
	}
	const resolved = path.join(fs.realpathSync(probe), ...rest);
	const rel = path.relative(root, resolved);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return resolved;
}

function hasMarker(skillFile: string, id: string): boolean {
	try {
		return fs
			.readFileSync(skillFile, "utf-8")
			.split(/\r?\n/)
			.includes(marker(id));
	} catch {
		return false;
	}
}

function requireCatalogPlugin(pluginId: string): MarketplacePlugin {
	const plugin = loadPluginCatalog().find((p) => p.id === pluginId);
	if (!plugin || !SKILL_NAME.test(plugin.id)) {
		throw new Error(`Plugin '${pluginId}' not found in catalog`);
	}
	return plugin;
}

/** The catalog plugins installed in the project. */
export function listInstalledPlugins(projectPath: string): InstalledPlugin[] {
	const root = projectRoot(projectPath);
	const installed: InstalledPlugin[] = [];
	for (const plugin of loadPluginCatalog()) {
		const paths = SKILL_ROOTS.map((r) => path.join(r, plugin.id)).filter(
			(rel) => {
				const dir = insideProject(root, rel);
				return dir !== null && hasMarker(path.join(dir, "SKILL.md"), plugin.id);
			},
		);
		if (paths.length > 0) {
			installed.push({
				pluginId: plugin.id,
				name: plugin.name,
				type: plugin.type,
				paths: paths.map((p) => p.split(path.sep).join("/")),
			});
		}
	}
	return installed;
}

/** Writes the plugin's skill into the project. */
export function installPlugin(
	projectPath: string,
	pluginId: string,
): InstalledPlugin {
	const plugin = requireCatalogPlugin(pluginId);
	const root = projectRoot(projectPath);
	const targets = SKILL_ROOTS.map((r) => {
		const rel = path.join(r, plugin.id);
		const dir = insideProject(root, rel);
		if (!dir) throw new Error(`${rel} leaves the project`);
		const file = path.join(dir, "SKILL.md");
		if (fs.existsSync(dir) && !hasMarker(file, plugin.id)) {
			throw new Error(
				`A skill named '${plugin.id}' already exists in ${rel.split(path.sep).join("/")}`,
			);
		}
		return { rel, dir, file };
	});
	const content = renderPluginSkill(plugin);
	for (const { dir, file } of targets) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, content, "utf-8");
	}
	return {
		pluginId: plugin.id,
		name: plugin.name,
		type: plugin.type,
		paths: targets.map((t) => t.rel.split(path.sep).join("/")),
	};
}

/**
 * Removes the `SKILL.md` the marketplace wrote, and its folder once empty: a
 * file the user added next to it stays.
 */
export function uninstallPlugin(projectPath: string, pluginId: string): void {
	const plugin = requireCatalogPlugin(pluginId);
	const root = projectRoot(projectPath);
	for (const r of SKILL_ROOTS) {
		const dir = insideProject(root, path.join(r, plugin.id));
		if (dir && hasMarker(path.join(dir, "SKILL.md"), plugin.id)) {
			fs.rmSync(path.join(dir, "SKILL.md"), { force: true });
			if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
		}
	}
}
