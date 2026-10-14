/**
 * @vitest-environment node
 *
 * The backend's own .env (the source env) holds the Claude token the
 * environment dialog saves. Packaged, only the main process reads it: its
 * secrets are encrypted. Running from source, Python loads it itself: its
 * secrets stay in clear, the file is 0600 and the UI names it.
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
import {
	fakeEncrypted,
	sharedFakeSafeStorage,
} from "../../__tests__/helpers/fake-safe-storage";

const paths = vi.hoisted(() => ({ userData: "", packaged: false }));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return {
		app: {
			getPath: () => paths.userData,
			get isPackaged() {
				return paths.packaged;
			},
		},
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

const fake = sharedFakeSafeStorage();
const isWindows = process.platform === "win32";
const TOKEN = "sk-ant-oat01-test-0000";

type SourceEnv = typeof import("../source-env");
type SecretStorage = typeof import("../secret-storage");

async function load(): Promise<SourceEnv & SecretStorage> {
	vi.resetModules();
	return {
		...(await import("../source-env")),
		...(await import("../secret-storage")),
	};
}

function envFile(): string {
	return path.join(paths.userData, ".env");
}

function onDisk(): string {
	return readFileSync(envFile(), "utf-8");
}

function variable(content: string, key: string): string | undefined {
	const line = content.split("\n").find((l) => l.startsWith(`${key}=`));
	return line?.slice(key.length + 1);
}

describe("backend .env secrets", () => {
	beforeEach(() => {
		fake.reset();
		paths.userData = mkdtempSync(path.join(tmpdir(), "source-env-"));
		paths.packaged = false;
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		rmSync(paths.userData, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("names the credential variables, not the settings around them", async () => {
		const { isSourceEnvSecretKey } = await load();

		for (const key of [
			"CLAUDE_CODE_OAUTH_TOKEN",
			"ANTHROPIC_API_KEY",
			"GITHUB_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"AZURE_DEVOPS_PAT",
		]) {
			expect(isSourceEnvSecretKey(key), key).toBe(true);
		}
		for (const key of [
			"CLAUDE_CODE_MAX_OUTPUT_TOKENS",
			"OLLAMA_BASE_URL",
			"GRAPHITI_ENABLED",
			"PATH",
		]) {
			expect(isSourceEnvSecretKey(key), key).toBe(false);
		}
	});

	describe("packaged: only the main process reads the file", () => {
		it("encrypts the token and keeps the other variables", async () => {
			const { writeSourceEnvFile, getSecureStorageStatus } = await load();

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: false },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, DEBUG: "true" },
			);

			const content = onDisk();
			expect(content).not.toContain(TOKEN);
			expect(variable(content, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(
				fakeEncrypted(TOKEN),
			);
			expect(variable(content, "DEBUG")).toBe("true");
			expect(getSecureStorageStatus().secretsAtRisk).toBe(false);
		});

		it.skipIf(isWindows)("writes the file 0600", async () => {
			const { writeSourceEnvFile } = await load();
			writeFileSync(envFile(), "DEBUG=true\n", { mode: 0o644 });

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: false },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
			);

			expect(statSync(envFile()).mode & 0o777).toBe(0o600);
		});

		it("leaves a value already encrypted as it is", async () => {
			const { writeSourceEnvFile } = await load();

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: false },
				{ CLAUDE_CODE_OAUTH_TOKEN: fakeEncrypted(TOKEN) },
			);

			expect(variable(onDisk(), "CLAUDE_CODE_OAUTH_TOKEN")).toBe(
				fakeEncrypted(TOKEN),
			);
		});

		it("without a keyring, keeps the token in clear and warns — never silently", async () => {
			fake.state.backend = "basic_text";
			const { writeSourceEnvFile, getSecureStorageStatus } = await load();

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: false },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
			);

			expect(variable(onDisk(), "CLAUDE_CODE_OAUTH_TOKEN")).toBe(TOKEN);
			expect(getSecureStorageStatus()).toMatchObject({
				secretsAtRisk: true,
				encryptionUnavailable: true,
			});
		});

		it("migrates a token an earlier version wrote in clear", async () => {
			writeFileSync(
				envFile(),
				`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\nDEBUG=true\n`,
				{ mode: 0o644 },
			);
			const { migrateSourceEnvSecrets } = await load();

			expect(
				migrateSourceEnvSecrets({ envPath: envFile(), readByBackend: false }),
			).toBe(true);

			const content = onDisk();
			expect(content).not.toContain(TOKEN);
			expect(variable(content, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(
				fakeEncrypted(TOKEN),
			);
			expect(variable(content, "DEBUG")).toBe("true");
			if (!isWindows) expect(statSync(envFile()).mode & 0o777).toBe(0o600);
		});

		it("does not rewrite a file with nothing left in clear, but still restricts it", async () => {
			const content = `CLAUDE_CODE_OAUTH_TOKEN=${fakeEncrypted(TOKEN)}\n`;
			writeFileSync(envFile(), content, { mode: 0o644 });
			const { migrateSourceEnvSecrets } = await load();

			expect(
				migrateSourceEnvSecrets({ envPath: envFile(), readByBackend: false }),
			).toBe(false);

			expect(onDisk()).toBe(content);
			if (!isWindows) expect(statSync(envFile()).mode & 0o777).toBe(0o600);
		});

		it("has nothing to migrate before the first save", async () => {
			const { migrateSourceEnvSecrets } = await load();

			expect(
				migrateSourceEnvSecrets({ envPath: envFile(), readByBackend: false }),
			).toBe(false);
		});
	});

	describe("from source: Python loads the file itself", () => {
		it("keeps the token in clear, readable by Python, and names the file", async () => {
			const { writeSourceEnvFile, getSecureStorageStatus } = await load();

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: true },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
			);

			expect(variable(onDisk(), "CLAUDE_CODE_OAUTH_TOKEN")).toBe(TOKEN);
			expect(getSecureStorageStatus()).toMatchObject({
				keyringAvailable: true,
				secretsAtRisk: true,
				encryptionUnavailable: false,
				plaintextFiles: [envFile()],
			});
		});

		it.skipIf(isWindows)("writes the file 0600", async () => {
			const { writeSourceEnvFile } = await load();
			writeFileSync(envFile(), "DEBUG=true\n", { mode: 0o644 });

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: true },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
			);

			expect(statSync(envFile()).mode & 0o777).toBe(0o600);
		});

		it("stops naming the file once the token is cleared", async () => {
			const { writeSourceEnvFile, getSecureStorageStatus } = await load();
			const file = { envPath: envFile(), readByBackend: true };

			writeSourceEnvFile(file, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
			writeSourceEnvFile(file, { CLAUDE_CODE_OAUTH_TOKEN: "" });

			expect(getSecureStorageStatus()).toMatchObject({
				secretsAtRisk: false,
				plaintextFiles: [],
			});
		});

		it("does not warn for a file holding no secret", async () => {
			const { writeSourceEnvFile, getSecureStorageStatus } = await load();

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: true },
				{ DEBUG: "true" },
			);

			expect(getSecureStorageStatus().secretsAtRisk).toBe(false);
		});

		it("migration restricts an existing file and names it, without rewriting it", async () => {
			const content = `# local\nOPENAI_API_KEY=sk-test-0000\n`;
			writeFileSync(envFile(), content, { mode: 0o644 });
			const { migrateSourceEnvSecrets, getSecureStorageStatus } = await load();

			expect(
				migrateSourceEnvSecrets({ envPath: envFile(), readByBackend: true }),
			).toBe(false);

			expect(onDisk()).toBe(content);
			if (!isWindows) expect(statSync(envFile()).mode & 0o777).toBe(0o600);
			expect(getSecureStorageStatus().plaintextFiles).toEqual([envFile()]);
		});

		it("tells the UI as soon as the file is named", async () => {
			const { writeSourceEnvFile, onSecureStorageStatusChange } = await load();
			const listener = vi.fn();
			onSecureStorageStatusChange(listener);

			writeSourceEnvFile(
				{ envPath: envFile(), readByBackend: true },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
			);

			expect(listener).toHaveBeenLastCalledWith(
				expect.objectContaining({
					secretsAtRisk: true,
					plaintextFiles: [envFile()],
				}),
			);
		});
	});

	describe("what a backend subprocess gets (loadBackendEnv)", () => {
		let backendDir: string;

		beforeEach(() => {
			backendDir = path.join(paths.userData, "resources-backend");
			mkdirSync(backendDir);
			mkdirSync(path.join(paths.userData, "backend"));
		});

		it("packaged, the token the UI saved, decrypted, over the bundled backend's", async () => {
			paths.packaged = true;
			writeFileSync(
				path.join(backendDir, ".env"),
				"DEBUG=true\nCLAUDE_CODE_OAUTH_TOKEN=bundled-0000\n",
			);
			const { writeSourceEnvFile, getPackagedSourceEnvPath, loadBackendEnv } =
				await load();
			writeSourceEnvFile(
				{ envPath: getPackagedSourceEnvPath(), readByBackend: false },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
			);

			expect(loadBackendEnv(backendDir)).toEqual({
				DEBUG: "true",
				CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
			});
		});

		it("leaves out a token the keyring cannot decrypt, never passing ciphertext", async () => {
			paths.packaged = true;
			const { writeSourceEnvFile, getPackagedSourceEnvPath, loadBackendEnv } =
				await load();
			writeSourceEnvFile(
				{ envPath: getPackagedSourceEnvPath(), readByBackend: false },
				{ CLAUDE_CODE_OAUTH_TOKEN: TOKEN, DEBUG: "true" },
			);
			fake.state.failDecrypt = true;

			expect(loadBackendEnv(backendDir)).toEqual({ DEBUG: "true" });
		});

		it("an empty line in the saved copy does not mask the backend's value", async () => {
			paths.packaged = true;
			writeFileSync(
				path.join(backendDir, ".env"),
				"CLAUDE_CODE_OAUTH_TOKEN=from-backend-0000\n",
			);
			const { writeSourceEnvFile, getPackagedSourceEnvPath, loadBackendEnv } =
				await load();
			// The writer always emits the token line, empty when there is none.
			writeSourceEnvFile(
				{ envPath: getPackagedSourceEnvPath(), readByBackend: false },
				{},
			);

			expect(loadBackendEnv(backendDir).CLAUDE_CODE_OAUTH_TOKEN).toBe(
				"from-backend-0000",
			);
		});

		it("from source, reads the backend's own .env as Python does, and nothing else", async () => {
			writeFileSync(
				path.join(backendDir, ".env"),
				`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`,
			);
			writeFileSync(
				path.join(paths.userData, "backend", ".env"),
				"CLAUDE_CODE_OAUTH_TOKEN=stale-0000\n",
			);
			const { loadBackendEnv } = await load();

			expect(loadBackendEnv(backendDir)).toEqual({
				CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
			});
		});
	});
});
