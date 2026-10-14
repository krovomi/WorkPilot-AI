/**
 * @vitest-environment node
 */

import { describe, expect, it } from "vitest";
import {
	REDACTED,
	redactSecrets,
	redactValue,
} from "../secret-redaction";

describe("redactSecrets", () => {
	it.each([
		["Anthropic key", "key sk-ant-api03-AbCdEf123456_789", "key sk-ant-[REDACTED]"],
		["OpenAI key", "using sk-proj-AbCdEfGhIjKlMnOpQrSt", "using sk-[REDACTED]"],
		["GitHub token", "ghp_0123456789abcdefghijABCDEFGHIJ012345 failed", "ghp_[REDACTED] failed"],
		["GitHub PAT", "github_pat_11ABCDEFG0123456789_abcdefghij", "github_pat_[REDACTED]"],
		["GitLab token", "glpat-AbCdEfGhIjKlMnOpQrSt", "glpat-[REDACTED]"],
		["Google key", "AIzaSyA-1234567890abcdefghijklmnopqrs", "AIza[REDACTED]"],
		["Groq key", "gsk_abcdefghijklmnopqrstuvwxyz0123", "gsk_[REDACTED]"],
		["AWS key id", "AKIAIOSFODNN7EXAMPLE", "AKIA[REDACTED]"],
		[
			"JWT",
			"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
			"jwt eyJ[REDACTED]",
		],
	])("masks a %s, keeping its prefix", (_label, input, expected) => {
		expect(redactSecrets(input)).toBe(expected);
	});

	it("masks bearer credentials and URL passwords", () => {
		expect(redactSecrets("Authorization: Bearer abc.def-ghi_jkl")).toBe(
			`Authorization: Bearer ${REDACTED}`,
		);
		expect(
			redactSecrets("cloning https://x-access-token:s3cr3tvalue@github.com/o/r"),
		).toBe(`cloning https://x-access-token:${REDACTED}@github.com/o/r`);
	});

	it("masks the value next to a sensitive name, whatever its format", () => {
		expect(redactSecrets("ANTHROPIC_API_KEY=sk-ant-api03-abcdef123")).toBe(
			`ANTHROPIC_API_KEY=${REDACTED}`,
		);
		expect(redactSecrets('{"apiKey": "opaque-key-123", "name": "work"}')).toBe(
			`{"apiKey": "${REDACTED}", "name": "work"}`,
		);
		expect(redactSecrets("GET /cb?code=1&access_token=abcd1234&state=x")).toBe(
			`GET /cb?code=1&access_token=${REDACTED}&state=x`,
		);
		expect(redactSecrets("password: hunter22")).toBe(`password: ${REDACTED}`);
	});

	it("leaves ordinary log lines alone", () => {
		for (const line of [
			"max_tokens=4096 input_tokens: 120",
			"hasToken: true, tokenCount: 3",
			"secretsAtRisk=false",
			"[TokenEncryption] Failed to refresh",
			"Basic auth failed",
			"https://github.com/org/repo",
			"enc:keychain-blob is not a key",
		]) {
			expect(redactSecrets(line)).toBe(line);
		}
	});

	it("is idempotent", () => {
		const once = redactSecrets(
			"ANTHROPIC_API_KEY=sk-ant-api03-abcdef123 ghp_0123456789abcdefghijABCDEFGHIJ",
		);
		expect(redactSecrets(once)).toBe(once);
	});
});

describe("redactValue", () => {
	it("masks sensitive keys and redacts nested strings without mutating input", () => {
		const input = {
			provider: "openai",
			apiKey: "opaque",
			nested: { refreshToken: "r-123", note: "sent sk-ant-api03-abcdefgh1" },
			list: ["Bearer abcdefghijkl"],
			maxTokens: 4096,
			hasToken: true,
		};

		expect(redactValue(input)).toEqual({
			provider: "openai",
			apiKey: REDACTED,
			nested: { refreshToken: REDACTED, note: `sent sk-ant-${REDACTED}` },
			list: [`Bearer ${REDACTED}`],
			maxTokens: 4096,
			hasToken: true,
		});
		expect(input.apiKey).toBe("opaque");
	});

	it("rebuilds errors with a redacted message and stack", () => {
		const error = new Error("401 for key sk-ant-api03-abcdefgh1");
		error.name = "AuthError";

		const result = redactValue(error) as Error;

		expect(result).toBeInstanceOf(Error);
		expect(result.name).toBe("AuthError");
		expect(result.message).toBe(`401 for key sk-ant-${REDACTED}`);
		expect(result.stack).not.toContain("abcdefgh1");
		expect(error.message).toContain("abcdefgh1");
	});

	it("survives cycles", () => {
		const node: Record<string, unknown> = { token: "abcdef" };
		node.self = node;

		expect(() => redactValue(node)).not.toThrow();
		expect((redactValue(node) as Record<string, unknown>).token).toBe(REDACTED);
	});
});
