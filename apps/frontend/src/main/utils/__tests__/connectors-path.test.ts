import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectorsRoot } from "../connectors-path";

/**
 * Jira, Azure DevOps and the provider settings of the backend import
 * `src.connectors`. The installed app used to ship the backend without it,
 * so these views failed there and only there.
 */
describe("shared connectors", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("are found in the installed app's backend", () => {
		dir = mkdtempSync(path.join(tmpdir(), "connectors-"));
		const backend = path.join(dir, "resources", "backend");
		mkdirSync(path.join(backend, "src", "connectors"), { recursive: true });
		expect(connectorsRoot(backend)).toBe(backend);
	});

	it("are found at the repository root next to apps/backend", () => {
		dir = mkdtempSync(path.join(tmpdir(), "connectors-"));
		const backend = path.join(dir, "apps", "backend");
		mkdirSync(backend, { recursive: true });
		mkdirSync(path.join(dir, "src", "connectors"), { recursive: true });
		expect(connectorsRoot(backend)).toBe(dir);
	});

	it("ship with the installed app, inside its backend", () => {
		const pkg = JSON.parse(
			readFileSync(path.resolve(__dirname, "..", "..", "..", "..", "package.json"), "utf-8"),
		) as { build: { extraResources: { from: string; to: string }[] } };
		const entry = pkg.build.extraResources.find((r) => r.to === "backend/src");
		expect(entry?.from).toBe("../../src");
	});
});
