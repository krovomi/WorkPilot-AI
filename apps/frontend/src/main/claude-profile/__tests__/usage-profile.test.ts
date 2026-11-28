/**
 * readClaudeUsage: the selected Claude account's usage, or the reason it
 * cannot be read. A lost sign-in always offers to reconnect.
 */

import type { ClaudeProfile, UsageSnapshot } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAuthFailure, readClaudeUsage } from "../usage-profile";

const profile = { id: "work", name: "Work", email: "work@example.com" } as ClaudeProfile;

const httpError = (statusCode: number, message = `HTTP ${statusCode}`) =>
	Object.assign(new Error(message), { statusCode });

function reader(fetchWith: () => Promise<UsageSnapshot | null>, signedIn = true) {
	return {
		credentialOf: vi.fn(async () => (signedIn ? "test-token" : undefined)),
		fetchWith: vi.fn(fetchWith),
		needsReauth: new Set<string>(),
	};
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("isAuthFailure", () => {
	it("is a 401, a 403 or a refusal read in the body", () => {
		expect(isAuthFailure(httpError(401))).toBe(true);
		expect(isAuthFailure(httpError(403))).toBe(true);
		expect(isAuthFailure(httpError(400, "API Auth Failure detected in response body"))).toBe(true);
	});

	it("is nothing else", () => {
		expect(isAuthFailure(httpError(500))).toBe(false);
		expect(isAuthFailure(new Error("API Auth Failure"))).toBe(false);
		expect(isAuthFailure({ statusCode: 401, message: "Auth Failure" })).toBe(false);
		expect(isAuthFailure(undefined)).toBe(false);
	});
});

describe("readClaudeUsage", () => {
	it("names the provider of a snapshot the CLI read", async () => {
		const snapshot = { sessionPercent: 12, weeklyPercent: 34 } as UsageSnapshot;
		const r = reader(async () => snapshot);

		expect(await readClaudeUsage(profile, r)).toMatchObject({ sessionPercent: 12, providerName: "anthropic" });
		expect(r.fetchWith).toHaveBeenCalledWith(profile, "test-token");

		const openai = { ...snapshot, providerName: "openai" } as UsageSnapshot;
		expect((await readClaudeUsage(profile, reader(async () => openai)))?.providerName).toBe("openai");
	});

	it("offers to reconnect when the API refuses the token, and remembers it", async () => {
		const r = reader(async () => {
			throw httpError(401);
		});

		expect(await readClaudeUsage(profile, r)).toMatchObject({
			profileId: "work",
			profileEmail: "work@example.com",
			needsReauthentication: true,
		});
		expect(r.needsReauth.has("work")).toBe(true);
	});

	it("lets any other failure through", async () => {
		const r = reader(async () => {
			throw new Error("store busy");
		});

		await expect(readClaudeUsage(profile, r)).rejects.toThrow("store busy");
		expect(r.needsReauth.size).toBe(0);
	});

	it("without a token, offers to reconnect only a lost sign-in", async () => {
		const r = reader(async () => null, false);

		expect(await readClaudeUsage(profile, r)).toBeNull();
		expect(r.fetchWith).not.toHaveBeenCalled();

		r.needsReauth.add("work");
		expect((await readClaudeUsage(profile, r))?.needsReauthentication).toBe(true);
	});

	it("when nothing could be read, offers to reconnect only a lost sign-in", async () => {
		const r = reader(async () => null);

		expect(await readClaudeUsage(profile, r)).toBeNull();

		r.needsReauth.add("work");
		expect((await readClaudeUsage(profile, r))?.needsReauthentication).toBe(true);
	});
});
