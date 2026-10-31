/**
 * The person's tokens on the server: a closed list of kinds, a value sent
 * once and never read back, and a refusal never quoted back to the view.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock("../server-connection", () => ({ authedFetch: mocks.authedFetch }));

import {
	deleteServerSecret,
	listServerSecrets,
	setServerSecret,
} from "../server-user-secrets";

const TOKEN = `ghp_${"A".repeat(36)}`; // pragma: allowlist secret

beforeEach(() => mocks.authedFetch.mockReset());

describe("server user secrets", () => {
	it("lists only the kinds the app knows", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: true,
			data: { kinds: ["github_token", "ssh_key", 3] },
		});
		expect(await listServerSecrets()).toEqual({
			success: true,
			data: ["github_token"],
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/secrets", "GET");
	});

	it("sends a token once, trimmed, for a known kind", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { saved: true } });
		expect(await setServerSecret("github_token", `  ${TOKEN}\n`)).toEqual({
			success: true,
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith("/users/me/secrets", "PUT", {
			kind: "github_token",
			value: TOKEN,
		});
	});

	it("refuses an unknown kind or a malformed token without asking the server", async () => {
		for (const [kind, value] of [
			["ssh_key", TOKEN],
			["github_token", ""],
			["github_token", "two words"],
			["github_token", "x".repeat(4_097)],
			["github_token", 42],
		] as const) {
			const result = await setServerSecret(kind, value);
			expect(result.success).toBe(false);
		}
		expect(await deleteServerSecret("../users")).toEqual({
			success: false,
			error: "Unknown token",
		});
		expect(mocks.authedFetch).not.toHaveBeenCalled();
	});

	it("never passes on an error that is not a plain reason", async () => {
		mocks.authedFetch.mockResolvedValue({
			ok: false,
			error: [{ input: TOKEN, msg: "too long" }],
		});
		const result = await setServerSecret("github_token", TOKEN);
		expect(result).toEqual({
			success: false,
			error: "The server refused the token",
		});
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("removes a token by its kind", async () => {
		mocks.authedFetch.mockResolvedValue({ ok: true, data: { deleted: true } });
		expect(await deleteServerSecret("gitlab_token")).toEqual({ success: true });
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/users/me/secrets/gitlab_token",
			"DELETE",
		);
	});
});
