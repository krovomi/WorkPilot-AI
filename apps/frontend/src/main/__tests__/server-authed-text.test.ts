/**
 * `authedFetch(..., "text")` hands back the server's answer as it came (a
 * CSV, a file to save) instead of parsing it as JSON.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = vi.hoisted(() => ({ path: "" }));
vi.mock("electron", () => ({
	app: { getPath: () => dir.path },
	safeStorage: { isAsyncEncryptionAvailable: async () => false },
}));

import {
	authedFetch,
	flushPersistedState,
	loginWithSsoIdToken,
	setMode,
} from "../server-connection";

dir.path = mkdtempSync(path.join(tmpdir(), "wp-text-"));

afterAll(async () => {
	setMode("local");
	await flushPersistedState();
	vi.unstubAllGlobals();
	rmSync(dir.path, { recursive: true, force: true });
});

describe("authedFetch as text", () => {
	it("returns the body untouched", async () => {
		const answers = [
			JSON.stringify({
				access_token: "access",
				refresh_token: "refresh",
				expires_in: 900,
				user: { id: "u1", email: "ada@example.com", display_name: "Ada", role: "member" },
			}),
			"day,tokens\n2026-11-27,700\n",
			'{"a":1}',
		];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(answers.shift(), { status: 200 })),
		);
		setMode("server", "https://wp.example.test");
		expect((await loginWithSsoIdToken("id-token")).ok).toBe(true);
		expect(await authedFetch<string>("/admin/usage/export?view=daily", "GET", undefined, "text")).toEqual({
			ok: true,
			data: "day,tokens\n2026-11-27,700\n",
		});
		expect(await authedFetch("/x", "GET")).toEqual({ ok: true, data: { a: 1 } });
	});
});
