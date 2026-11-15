import { describe, expect, it } from "vitest";
import { loadBetterSqlite } from "../windsurf-sqlite";

describe("loadBetterSqlite", () => {
	it("loads the better-sqlite3 constructor, whose binding opens on first use", () => {
		// The JavaScript loads even where the native binding was never built
		// (CI installs without build scripts): only `new Database()` needs it.
		const Database = loadBetterSqlite();
		expect(typeof Database).toBe("function");
		expect(Database.name).toBe("Database");
	});
});
