/**
 * @vitest-environment node
 *
 * The variables a provider's default account adds to the backend's
 * environment (account-env.ts): the AWS key pair and region, the key of
 * Cursor and Windsurf, nothing for the other providers, and nothing when the
 * store cannot be read.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/unused" } }));
vi.mock("../../secret-storage", () => ({
	encryptSecret: (value: string) => `enc:${value}`,
	decryptSecret: (stored: string) => stored.replace(/^enc:/, ""),
}));
const warn = vi.hoisted(() => vi.fn());
vi.mock("../../app-logger", () => ({ appLog: { warn } }));

import { defaultAccountEnv } from "../account-env";
import { AiAccountStore, setAiAccountStoreForTests } from "../ai-accounts";

let dir: string;
let file: string;
let store: AiAccountStore;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "account-env-"));
	file = path.join(dir, "config", "ai-accounts.json");
	store = new AiAccountStore(file);
	setAiAccountStoreForTests(store);
	warn.mockReset();
});

afterEach(() => {
	setAiAccountStoreForTests(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("defaultAccountEnv", () => {
	it("gives the AWS default account's key pair and region", () => {
		const aws = store.save({
			provider: "aws",
			name: "Prod",
			apiKey: "AKIATEST0000",
			secretKey: "secret-test-0000",
			region: "eu-west-3",
		});
		expect(defaultAccountEnv("aws")).toEqual({});
		store.setDefault("aws", aws.id);
		expect(defaultAccountEnv("aws")).toEqual({
			AWS_ACCESS_KEY_ID: "AKIATEST0000",
			AWS_SECRET_ACCESS_KEY: "secret-test-0000",
			AWS_DEFAULT_REGION: "eu-west-3",
		});
	});

	it("gives nothing when the AWS default has lost its secret", () => {
		const aws = store.save({ provider: "aws", name: "Prod", apiKey: "AKIATEST0000", secretKey: "s-0" });
		store.setDefault("aws", aws.id);
		vi.spyOn(store, "pairOf").mockReturnValue(undefined);
		expect(defaultAccountEnv("aws")).toEqual({});
	});

	it("gives the key of Cursor and Windsurf under their own variable", () => {
		const cursor = store.save({ provider: "cursor", name: "C", apiKey: "key-cursor-0" });
		const windsurf = store.save({ provider: "windsurf", name: "W", apiKey: "key-windsurf-0" });
		store.setDefault("cursor", cursor.id);
		store.setDefault("windsurf", windsurf.id);
		expect(defaultAccountEnv(" Cursor ")).toEqual({ CURSOR_API_KEY: "key-cursor-0" });
		expect(defaultAccountEnv("windsurf")).toEqual({ WINDSURF_API_KEY: "key-windsurf-0" });
	});

	it("leaves the other providers to their usual key lookup", () => {
		const openai = store.save({ provider: "openai", name: "O", apiKey: "sk-test-0" });
		store.setDefault("openai", openai.id);
		expect(defaultAccountEnv("openai")).toEqual({});
		expect(defaultAccountEnv("ollama")).toEqual({});
		expect(defaultAccountEnv(undefined)).toEqual({});
		expect(defaultAccountEnv(null)).toEqual({});
	});

	it("gives nothing, with a warning, when the store cannot be read", () => {
		vi.spyOn(store, "defaultOf").mockImplementation(() => {
			throw new Error("locked");
		});
		expect(defaultAccountEnv("cursor")).toEqual({});
		expect(warn).toHaveBeenCalledWith("[AiAccounts] default account unreadable:", "locked");
	});
});
