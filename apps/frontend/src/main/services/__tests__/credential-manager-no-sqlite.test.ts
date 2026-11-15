/**
 * A build where better-sqlite3 cannot load (its native binding was not built
 * for this Electron): the Windsurf readers say so instead of throwing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../windsurf-sqlite", () => ({
	loadBetterSqlite: () => {
		throw new Error("Could not locate the bindings file");
	},
}));
vi.mock("../../settings-utils", () => ({
	readSettingsFile: () => undefined,
	writeSettingsFile: vi.fn(),
}));
vi.mock("../../utils/profile-manager", () => ({
	loadProfilesFile: async () => ({ profiles: [], activeProfileId: null }),
	saveProfilesFile: vi.fn(),
}));

import {
	detectWindsurfLocalToken,
	readWindsurfCachedPlanInfo,
} from "../credential-manager";

let home: string;
const savedEnv = { HOME: process.env.HOME, APPDATA: process.env.APPDATA };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "windsurf-nosqlite-"));
	process.env.HOME = home;
	process.env.APPDATA = join(home, "AppData", "Roaming");
	const tail = ["Windsurf", "User", "globalStorage", "state.vscdb"];
	for (const file of [
		join(home, "AppData", "Roaming", ...tail),
		join(home, "Library", "Application Support", ...tail),
		join(home, ".config", ...tail),
	]) {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, "");
	}
});

afterEach(() => {
	process.env.HOME = savedEnv.HOME;
	if (savedEnv.APPDATA === undefined) delete process.env.APPDATA;
	else process.env.APPDATA = savedEnv.APPDATA;
	rmSync(home, { recursive: true, force: true });
});

describe("Windsurf readers without better-sqlite3", () => {
	it("detectWindsurfLocalToken reports the missing module", async () => {
		const result = await detectWindsurfLocalToken();
		expect(result.success).toBe(false);
		expect(result.error).toBe(
			"better-sqlite3 module not available: Could not locate the bindings file",
		);
	});

	it("readWindsurfCachedPlanInfo reports the missing module", async () => {
		const result = await readWindsurfCachedPlanInfo();
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^better-sqlite3 not available: /);
	});
});
