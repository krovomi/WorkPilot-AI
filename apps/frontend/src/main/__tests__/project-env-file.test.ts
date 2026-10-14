/**
 * @vitest-environment node
 *
 * A project's `.workpilot/.env` (project-env-file.ts): the tokens the backend
 * only takes from its environment are stored `enc:`, the ones it reads from
 * the file stay readable and are named to the UI, the file is owner-only, and
 * an earlier version's file is migrated. Rule S1: never a secret in clear
 * without the user being told.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import projectEnvSecrets from "../../shared/constants/project-env-secrets.json";
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../__tests__/helpers/fake-safe-storage";
import { isWindows } from "../platform";

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return { safeStorage: sharedFakeSafeStorage().safeStorage };
});

// The keyring backend check only exists on Linux; pin it for every CI OS.
vi.mock("../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../platform")>()),
	isLinux: () => true,
}));

const fake = sharedFakeSafeStorage();

async function load() {
	vi.resetModules();
	const projectEnv = await import("../project-env-file");
	const storage = await import("../secret-storage");
	return { ...projectEnv, storage };
}

const LEGACY_ENV = [
	"# WorkPilot AI Framework Environment Variables",
	"CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-legacy",
	"LINEAR_ENABLED=true",
	'GITHUB_TOKEN="ghp_legacyToken"',
	"# GITLAB_TOKEN=",
	"CONTEXT7_API_KEY=ctx7sk-readable",
	"SLACK_WEBHOOK_URL=https://example.com/slack-webhook-0000",
	"DEFAULT_BRANCH=main",
	"",
].join("\n");

describe("project-env-file", () => {
	let dir: string;
	let envPath: string;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fake.reset();
		warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		dir = mkdtempSync(path.join(tmpdir(), "project-env-"));
		envPath = path.join(dir, ".workpilot", ".env");
	});

	afterEach(() => {
		warn.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	});

	it("classifies every key once", () => {
		const overlap = projectEnvSecrets.encrypted.filter((key) =>
			projectEnvSecrets.readable.includes(key),
		);
		expect(overlap).toEqual([]);
	});

	describe("with an OS keyring", () => {
		it("writes encrypted keys as enc:, keeps every other line as is", async () => {
			const { writeProjectEnvFile } = await load();

			writeProjectEnvFile(envPath, LEGACY_ENV);

			const written = readFileSync(envPath, "utf-8");
			expect(written).not.toContain("sk-ant-oat01-legacy");
			expect(written).not.toContain("ghp_legacyToken");
			expect(written).toContain(
				`CLAUDE_CODE_OAUTH_TOKEN=${fakeEncrypted("sk-ant-oat01-legacy")}`,
			);
			expect(written).toContain(`GITHUB_TOKEN=${fakeEncrypted("ghp_legacyToken")}`);
			expect(written).toContain("# WorkPilot AI Framework Environment Variables");
			expect(written).toContain("# GITLAB_TOKEN=");
			expect(written).toContain("LINEAR_ENABLED=true");
			expect(written).toContain("DEFAULT_BRANCH=main");
		});

		it.skipIf(isWindows())("writes the file owner-only", async () => {
			const { writeProjectEnvFile } = await load();

			writeProjectEnvFile(envPath, LEGACY_ENV);

			expect(statSync(envPath).mode & 0o777).toBe(0o600);
		});

		it("reads back plaintext, for subprocesses and handlers alike", async () => {
			const { writeProjectEnvFile, readProjectEnv } = await load();
			writeProjectEnvFile(envPath, LEGACY_ENV);

			const vars = readProjectEnv({ path: dir, autoBuildPath: ".workpilot" });

			expect(vars.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-legacy");
			expect(vars.GITHUB_TOKEN).toBe("ghp_legacyToken");
			expect(vars.DEFAULT_BRANCH).toBe("main");
			expect(vars.GITLAB_TOKEN).toBeUndefined();
		});

		it("does not encrypt twice, and preserves CRLF line endings", async () => {
			const { encodeProjectEnvContent } = await load();
			const crlf = "GITHUB_TOKEN=ghp_x\r\nGITHUB_REPO=a/b\r\n";

			const once = encodeProjectEnvContent(crlf);

			expect(once).toBe(`GITHUB_TOKEN=${fakeEncrypted("ghp_x")}\r\nGITHUB_REPO=a/b\r\n`);
			expect(encodeProjectEnvContent(once)).toBe(once);
			expect(fake.calls.encrypt).toBe(1);
		});

		it("leaves out a value it cannot decrypt, and the file keeps it", async () => {
			const blob = fakeEncrypted("ghp_other_machine");
			const { writeProjectEnvFile, readProjectEnvFile } = await load();
			writeProjectEnvFile(envPath, `GITHUB_TOKEN=${blob}\nGITHUB_REPO=a/b\n`);
			fake.state.failDecrypt = true;

			const vars = readProjectEnvFile(envPath);

			expect(vars).toEqual({ GITHUB_REPO: "a/b" });
			expect(readFileSync(envPath, "utf-8")).toContain(`GITHUB_TOKEN=${blob}`);
		});

		it("keeps readable secrets in clear and names them to the status", async () => {
			const { writeProjectEnvFile, storage } = await load();

			writeProjectEnvFile(envPath, LEGACY_ENV);

			const written = readFileSync(envPath, "utf-8");
			expect(written).toContain("CONTEXT7_API_KEY=ctx7sk-readable");
			expect(written).toContain(
				"SLACK_WEBHOOK_URL=https://example.com/slack-webhook-0000",
			);
			const status = storage.getSecureStorageStatus();
			expect(status.readableSecretKeys).toEqual([
				"CONTEXT7_API_KEY",
				"SLACK_WEBHOOK_URL",
			]);
			expect(status.secretsAtRisk).toBe(true);
			expect(JSON.stringify(status)).not.toContain("ctx7sk-readable");
		});

		it("clears the warning once the readable secrets are removed", async () => {
			const { writeProjectEnvFile, storage } = await load();
			writeProjectEnvFile(envPath, "CONTEXT7_API_KEY=ctx7sk-readable\n");

			writeProjectEnvFile(envPath, "# CONTEXT7_API_KEY=\n");

			expect(storage.getSecureStorageStatus()).toMatchObject({
				readableSecretKeys: [],
				secretsAtRisk: false,
			});
		});

		it("counts custom MCP servers as a secret only when they carry headers", async () => {
			const { readableSecretKeysOf } = await load();
			const plain = JSON.stringify([{ id: "a", type: "command", command: "npx" }]);
			const withAuth = JSON.stringify([
				{ id: "b", type: "http", url: "https://x", headers: { Authorization: "Bearer t" } },
			]);

			expect(readableSecretKeysOf(`CUSTOM_MCP_SERVERS=${plain}`)).toEqual([]);
			expect(readableSecretKeysOf(`CUSTOM_MCP_SERVERS=${withAuth}`)).toEqual([
				"CUSTOM_MCP_SERVERS",
			]);
		});
	});

	describe("without an OS keyring", () => {
		it("writes tokens in clear and flags them — never silently", async () => {
			fake.state.ready = false;
			const { writeProjectEnvFile, storage } = await load();

			writeProjectEnvFile(envPath, "GITHUB_TOKEN=ghp_plain\n");

			expect(readFileSync(envPath, "utf-8")).toBe("GITHUB_TOKEN=ghp_plain\n");
			expect(storage.getSecureStorageStatus()).toMatchObject({
				keyringAvailable: false,
				secretsAtRisk: true,
			});
		});
	});

	describe("migration", () => {
		it("encrypts the tokens an earlier version wrote in clear, once", async () => {
			mkdirSync(path.dirname(envPath), { recursive: true });
			writeFileSync(envPath, LEGACY_ENV, { mode: 0o644 });
			const { migrateProjectEnvSecrets } = await load();
			const project = { path: dir, autoBuildPath: ".workpilot" };

			expect(migrateProjectEnvSecrets([project])).toBe(1);
			expect(migrateProjectEnvSecrets([project])).toBe(0);

			const migrated = readFileSync(envPath, "utf-8");
			expect(migrated).not.toContain("sk-ant-oat01-legacy");
			expect(migrated).not.toContain("ghp_legacyToken");
			expect(migrated).toContain("CONTEXT7_API_KEY=ctx7sk-readable");
			expect(migrated.split("\n")).toHaveLength(LEGACY_ENV.split("\n").length);
			if (!isWindows()) expect(statSync(envPath).mode & 0o777).toBe(0o600);
		});

		it("reports readable secrets of files it does not rewrite", async () => {
			mkdirSync(path.dirname(envPath), { recursive: true });
			writeFileSync(envPath, "FIGMA_ACCESS_TOKEN=figd_readable\n");
			const { migrateProjectEnvFile, storage } = await load();

			expect(migrateProjectEnvFile(envPath)).toBe(false);
			expect(storage.getSecureStorageStatus().readableSecretKeys).toEqual([
				"FIGMA_ACCESS_TOKEN",
			]);
		});

		it("without a keyring, leaves the file and raises the warning", async () => {
			mkdirSync(path.dirname(envPath), { recursive: true });
			writeFileSync(envPath, LEGACY_ENV);
			fake.state.ready = false;
			const { migrateProjectEnvFile, storage } = await load();

			expect(migrateProjectEnvFile(envPath)).toBe(false);
			expect(readFileSync(envPath, "utf-8")).toBe(LEGACY_ENV);
			expect(storage.getSecureStorageStatus().secretsAtRisk).toBe(true);
		});

		it("skips projects without a file or not initialized", async () => {
			const { migrateProjectEnvSecrets } = await load();

			expect(
				migrateProjectEnvSecrets([
					{ path: dir, autoBuildPath: ".workpilot" },
					{ path: dir, autoBuildPath: null },
				]),
			).toBe(0);
		});
	});
});
