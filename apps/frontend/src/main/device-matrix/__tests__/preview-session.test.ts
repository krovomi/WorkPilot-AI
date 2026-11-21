/**
 * Lending the preview's session to a matrix capture (#383): only the cookies
 * the preview would send to the rendered origin are copied, host-only cookies
 * stay host-only, session cookies stay session cookies, and a cookie the store
 * refuses is skipped rather than failing the capture.
 */
import { describe, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("electron", () => ({ session: { defaultSession: { cookies: { get: preview.get } } } }));

import { MAX_SHARED_COOKIES, sharePreviewCookies } from "../preview-session";

const cookie = (overrides: Record<string, unknown> = {}) => ({
	name: "sid",
	value: "test-session-0000",
	domain: "localhost",
	hostOnly: true,
	path: "/",
	secure: false,
	httpOnly: true,
	session: true,
	expirationDate: undefined,
	sameSite: "lax",
	...overrides,
});

function target(refuse: (name: string) => boolean = () => false) {
	const set = vi.fn(async (details: { name: string }) => {
		if (refuse(details.name)) throw new Error("refused");
	});
	return { set, session: { cookies: { set } } as unknown as Electron.Session };
}

describe("sharePreviewCookies", () => {
	it("copies the cookies the preview sends to that origin, as they are", async () => {
		preview.get.mockResolvedValueOnce([
			cookie(),
			cookie({ name: "theme", value: "dark", domain: ".localhost", hostOnly: false, session: false, expirationDate: 2e9 }),
		]);
		const { set, session } = target();
		expect(await sharePreviewCookies(session, "http://localhost:5173")).toBe(2);
		expect(preview.get).toHaveBeenCalledWith({ url: "http://localhost:5173" });
		expect(set).toHaveBeenNthCalledWith(1, {
			url: "http://localhost:5173",
			name: "sid",
			value: "test-session-0000",
			domain: undefined,
			path: "/",
			secure: false,
			httpOnly: true,
			expirationDate: undefined,
			sameSite: "lax",
		});
		expect(set.mock.calls[1][0]).toMatchObject({ domain: ".localhost", expirationDate: 2e9 });
	});

	it("skips a cookie the store refuses and stops at MAX_SHARED_COOKIES", async () => {
		preview.get.mockResolvedValueOnce(
			Array.from({ length: MAX_SHARED_COOKIES + 5 }, (_, index) => cookie({ name: `c${index}` })),
		);
		const { set, session } = target((name) => name === "c0");
		expect(await sharePreviewCookies(session, "http://localhost:5173")).toBe(MAX_SHARED_COOKIES - 1);
		expect(set).toHaveBeenCalledTimes(MAX_SHARED_COOKIES);
	});

	it("lets a preview store that cannot be read fail the call", async () => {
		preview.get.mockRejectedValueOnce(new Error("gone"));
		await expect(sharePreviewCookies(target().session, "http://localhost:5173")).rejects.toThrow("gone");
	});
});
