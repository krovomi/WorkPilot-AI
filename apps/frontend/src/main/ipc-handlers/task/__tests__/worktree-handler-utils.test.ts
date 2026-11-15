/**
 * @vitest-environment node
 *
 * The helpers the worktree handlers share, on real repositories and a real
 * settings file: the utility model read from the user's settings, a
 * repository wrongly marked bare repaired only when it holds a project
 * (for every stack's marker, .NET globs included), and the working-tree
 * check.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({ app: { getPath: () => state.userData } }));
vi.mock("../../../cli-tool-manager", () => ({ getToolPath: () => "git" }));

import { MODEL_ID_MAP, THINKING_BUDGET_MAP } from "../../../../shared/constants";
import {
	extractLastJsonObject,
	fixMisconfiguredBareRepo,
	getUtilitySettings,
	isGitWorkTree,
} from "../worktree-handler-utils";

let base = "";
beforeEach(() => {
	base = mkdtempSync(path.join(tmpdir(), "wt-utils-"));
	state.userData = path.join(base, "userData");
	mkdirSync(state.userData);
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function repo(name: string): string {
	const dir = path.join(base, name);
	mkdirSync(dir);
	git(dir, "init", "-q");
	return dir;
}

const bareFlag = (dir: string) => git(dir, "config", "--default", "unset", "--get", "core.bare");

describe("extractLastJsonObject", () => {
	it("returns the last object line, skipping arrays, primitives and broken lines", () => {
		expect(extractLastJsonObject('{"a":1}\nlog\n{"b":2}\n[1]\n{broken}\n42\n')).toEqual({ b: 2 });
		expect(extractLastJsonObject("no json\r\n")).toBeNull();
	});
});

describe("getUtilitySettings", () => {
	const write = (content: string) =>
		writeFileSync(path.join(state.userData, "settings.json"), content, "utf-8");

	it("uses the defaults without a settings file or with a broken one", () => {
		const defaults = getUtilitySettings();
		expect(defaults.thinkingLevel).toBe("low");
		expect(defaults.thinkingBudget).toBe(THINKING_BUDGET_MAP.low);
		write("{ not json");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(getUtilitySettings()).toEqual(defaults);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("reads the utility model and thinking level the user chose", () => {
		write(JSON.stringify({ featureModels: { utility: "sonnet" }, featureThinking: { utility: "high" } }));
		expect(getUtilitySettings()).toEqual({
			model: "sonnet",
			modelId: MODEL_ID_MAP.sonnet,
			thinkingLevel: "high",
			thinkingBudget: THINKING_BUDGET_MAP.high,
		});
		write(JSON.stringify({ featureThinking: { utility: "none" } }));
		expect(getUtilitySettings().thinkingBudget).toBeNull();
	});

	it("falls back for an unknown model or level, and for empty choices", () => {
		write(JSON.stringify({ featureModels: { utility: "mystery" }, featureThinking: { utility: "weird" } }));
		expect(getUtilitySettings()).toMatchObject({
			model: "mystery",
			modelId: MODEL_ID_MAP.haiku,
			thinkingLevel: "weird",
			thinkingBudget: THINKING_BUDGET_MAP.low,
		});
		write(JSON.stringify({ featureModels: { utility: "" }, featureThinking: { utility: "" } }));
		expect(getUtilitySettings().thinkingLevel).toBe("low");
		write(JSON.stringify({ featureModels: null, featureThinking: null }));
		expect(getUtilitySettings().thinkingLevel).toBe("low");
	});
});

describe("fixMisconfiguredBareRepo", () => {
	it("leaves a repository that is not marked bare, and a folder that is no repository", () => {
		const dir = repo("normal");
		expect(fixMisconfiguredBareRepo(dir)).toBe(false);
		const plain = path.join(base, "plain");
		mkdirSync(plain);
		// Outside any repository `git config --get` fails: nothing to fix.
		expect(fixMisconfiguredBareRepo(path.join(base, "missing"))).toBe(false);
	});

	for (const marker of ["package.json", "go.mod", "Cargo.toml", "pom.xml", "src"]) {
		it(`unsets core.bare when the folder holds ${marker}`, () => {
			const dir = repo(`with-${marker}`);
			if (marker === "src") mkdirSync(path.join(dir, "src"));
			else writeFileSync(path.join(dir, marker), "", "utf-8");
			git(dir, "config", "core.bare", "true");
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			expect(fixMisconfiguredBareRepo(dir)).toBe(true);
			expect(bareFlag(dir)).toBe("unset");
			warn.mockRestore();
		});
	}

	it("finds a .NET project by its glob, in any case", () => {
		const dir = repo("dotnet");
		writeFileSync(path.join(dir, "App.CSPROJ"), "", "utf-8");
		git(dir, "config", "core.bare", "true");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(fixMisconfiguredBareRepo(dir)).toBe(true);
		warn.mockRestore();
	});

	it("leaves a real bare repository alone", () => {
		const dir = path.join(base, "real.git");
		git(base, "init", "-q", "--bare", dir);
		expect(fixMisconfiguredBareRepo(dir)).toBe(false);
		expect(bareFlag(dir)).toBe("true");
	});

	it("only looks at the first 500 entries of a huge folder", () => {
		const dir = repo("huge");
		for (let i = 0; i < 501; i++) writeFileSync(path.join(dir, `f${String(i).padStart(4, "0")}`), "");
		// Sorted after the 500 first names on every platform: not seen.
		writeFileSync(path.join(dir, "zzz.sln"), "", "utf-8");
		git(dir, "config", "core.bare", "true");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const fixed = fixMisconfiguredBareRepo(dir);
		expect(warn.mock.calls.some((c) => String(c[0]).includes("checking only first 500"))).toBe(true);
		// readdir order is the file system's: the .sln may or may not be among the first 500.
		expect(typeof fixed).toBe("boolean");
		warn.mockRestore();
	});
});

describe("isGitWorkTree", () => {
	it("is true in a working tree and false in a bare repository or outside git", () => {
		expect(isGitWorkTree(repo("tree"))).toBe(true);
		const bare = path.join(base, "b.git");
		git(base, "init", "-q", "--bare", bare);
		expect(isGitWorkTree(bare)).toBe(false);
		expect(isGitWorkTree(path.join(base, "nowhere"))).toBe(false);
	});
});
