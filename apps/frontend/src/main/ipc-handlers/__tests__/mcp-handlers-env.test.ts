import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { isMcpEnvSafe } from "../mcp-handlers";

describe("isMcpEnvSafe", () => {
	it("accepts the API key a catalog server reads", () => {
		expect(isMcpEnvSafe(undefined)).toBe(true);
		expect(isMcpEnvSafe({ NOTION_TOKEN: "ntn_dummy", SENTRY_HOST: "sentry.io" })).toBe(
			true,
		);
	});

	it.each<Record<string, string>>([
		{ NODE_OPTIONS: "--require /tmp/evil.js" },
		{ ld_preload: "/tmp/evil.so" },
		{ PATH: "/tmp/evil" },
		{ PYTHONPATH: "/tmp/evil" },
		{ NPM_CONFIG_REGISTRY: "https://evil.example" },
		{ UV_INDEX_URL: "https://evil.example" },
		{ "BAD-NAME": "x" },
		{ OK: "a\0b" },
	])("refuses %o", (env) => {
		expect(isMcpEnvSafe(env)).toBe(false);
	});
});
