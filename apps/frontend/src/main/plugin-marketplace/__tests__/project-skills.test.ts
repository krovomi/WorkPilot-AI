import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installPlugin,
	listInstalledPlugins,
	loadPluginCatalog,
	renderPluginSkill,
	uninstallPlugin,
} from "../project-skills";

let project: string;

beforeEach(() => {
	project = fs.mkdtempSync(path.join(os.tmpdir(), "wp-plugins-"));
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

const skillFile = (root: string, id: string) =>
	path.join(project, root, "skills", id, "SKILL.md");

describe("plugin catalog", () => {
	it("offers many plugins, all installable as skills", () => {
		const catalog = loadPluginCatalog();
		expect(catalog.length).toBeGreaterThanOrEqual(20);
		for (const plugin of catalog) {
			expect(plugin.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
			expect(["agent", "spec-template", "custom-prompt"]).toContain(plugin.type);
			expect(plugin.tagline.fr && plugin.description.fr).toBeTruthy();
			expect(plugin.skill.body.length).toBeGreaterThan(200);
		}
	});

	it("renders the Agent Skills frontmatter with the marketplace marker", () => {
		const plugin = loadPluginCatalog()[0];
		const lines = renderPluginSkill(plugin).split("\n");
		expect(lines.slice(0, 8)).toEqual([
			"---",
			`name: ${plugin.id}`,
			`description: ${JSON.stringify(plugin.skill.description)}`,
			"metadata:",
			"  workpilot:",
			`    plugin: ${plugin.id}`,
			`    plugin-type: ${plugin.type}`,
			"---",
		]);
	});
});

describe("install / uninstall in a project", () => {
	it("writes the skill to .agents/skills and .claude/skills, then lists it", () => {
		const installed = installPlugin(project, "security-audit");
		expect(installed.paths).toEqual([
			".agents/skills/security-audit",
			".claude/skills/security-audit",
		]);
		expect(fs.readFileSync(skillFile(".agents", "security-audit"), "utf-8")).toContain(
			"# Security audit",
		);
		expect(fs.existsSync(skillFile(".claude", "security-audit"))).toBe(true);
		expect(listInstalledPlugins(project).map((p) => p.pluginId)).toEqual([
			"security-audit",
		]);
	});

	it("installing twice rewrites its own skill", () => {
		installPlugin(project, "tdd");
		expect(() => installPlugin(project, "tdd")).not.toThrow();
	});

	it("refuses to overwrite a skill it did not write, and never lists or removes it", () => {
		const mine = skillFile(".agents", "tdd");
		fs.mkdirSync(path.dirname(mine), { recursive: true });
		fs.writeFileSync(mine, "---\nname: tdd\ndescription: mine\n---\nmy own\n", "utf-8");

		expect(() => installPlugin(project, "tdd")).toThrow(/already exists/);
		expect(listInstalledPlugins(project)).toEqual([]);
		uninstallPlugin(project, "tdd");
		expect(fs.readFileSync(mine, "utf-8")).toContain("my own");
		// Nothing half-written in the mirror either
		expect(fs.existsSync(skillFile(".claude", "tdd"))).toBe(false);
	});

	it("uninstall removes the skill but keeps a file the user added next to it", () => {
		installPlugin(project, "adr-writer");
		const extra = path.join(project, ".agents", "skills", "adr-writer", "notes.md");
		fs.writeFileSync(extra, "keep me", "utf-8");

		uninstallPlugin(project, "adr-writer");

		expect(fs.existsSync(skillFile(".agents", "adr-writer"))).toBe(false);
		expect(fs.readFileSync(extra, "utf-8")).toBe("keep me");
		expect(fs.existsSync(path.join(project, ".claude", "skills", "adr-writer"))).toBe(
			false,
		);
		expect(listInstalledPlugins(project)).toEqual([]);
	});

	it("rejects a plugin that is not in the catalog", () => {
		expect(() => installPlugin(project, "../../etc")).toThrow(/not found/);
		expect(() => uninstallPlugin(project, "nope")).toThrow(/not found/);
	});

	it("refuses to write through a symbolic link that leaves the project", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "wp-outside-"));
		try {
			// "junction" needs no privilege on Windows and is ignored elsewhere.
			fs.symlinkSync(outside, path.join(project, ".agents"), "junction");
			expect(() => installPlugin(project, "tdd")).toThrow(/leaves the project/);
			expect(fs.readdirSync(outside)).toEqual([]);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
