/**
 * @vitest-environment node
 *
 * The AUTOBUILD_SOURCE_ENV handlers write and read the Claude token in the
 * backend's own .env. Packaged, it is encrypted at rest; running from source,
 * Python reads the file itself, so it stays in clear, 0600, and the UI warns.
 */

import {
	existsSync,
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

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
const env = vi.hoisted(() => ({ userData: "", dev: false }));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import(
		"../../__tests__/helpers/fake-safe-storage"
	);
	return {
		ipcMain: {
			handle: (channel: string, handler: IpcHandler) => {
				handlers.set(channel, handler);
			},
		},
		app: {
			getPath: () => env.userData,
			getAppPath: () => env.userData,
			get isPackaged() {
				return !env.dev;
			},
		},
		dialog: { showOpenDialog: vi.fn() },
		shell: { openExternal: vi.fn() },
		safeStorage: sharedFakeSafeStorage().safeStorage,
	};
});

vi.mock("@electron-toolkit/utils", () => ({
	is: {
		get dev() {
			return env.dev;
		},
	},
}));

vi.mock("../cli-tool-manager", () => ({
	configureTools: vi.fn(),
	getToolInfo: vi.fn(),
	isPathFromWrongPlatform: vi.fn(() => false),
	preWarmToolCache: vi.fn(),
}));

vi.mock("../agent", () => ({ AgentManager: vi.fn() }));

vi.mock("../app-updater", () => ({
	setUpdateChannel: vi.fn(),
	setUpdateChannelWithDowngradeCheck: vi.fn(() => Promise.resolve()),
}));

const fake = sharedFakeSafeStorage();
const isWindows = process.platform === "win32";
const TOKEN = "sk-ant-oat01-test-0000";

let backendDir: string;

async function register() {
	vi.resetModules();
	handlers.clear();
	const { registerSettingsHandlers } = await import(
		"../ipc-handlers/settings-handlers"
	);
	const { IPC_CHANNELS } = await import("../../shared/constants");
	const secretStorage = await import("../secret-storage");
	registerSettingsHandlers(
		{} as never,
		(() => null) as never,
	);
	const call = (channel: string, ...args: unknown[]) => {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		return handler({}, ...args) as Promise<{
			success: boolean;
			data?: Record<string, unknown>;
			error?: string;
		}>;
	};
	return {
		update: (config: unknown) =>
			call(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_UPDATE, config),
		get: () => call(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_GET),
		check: () => call(IPC_CHANNELS.AUTOBUILD_SOURCE_ENV_CHECK_TOKEN),
		status: secretStorage.getSecureStorageStatus,
	};
}

function tokenLine(file: string): string | undefined {
	return readFileSync(file, "utf-8")
		.split("\n")
		.find((line) => line.startsWith("CLAUDE_CODE_OAUTH_TOKEN="));
}

describe("AUTOBUILD_SOURCE_ENV handlers", () => {
	beforeEach(() => {
		fake.reset();
		env.userData = mkdtempSync(path.join(tmpdir(), "source-env-handlers-"));
		backendDir = path.join(env.userData, "apps-backend");
		mkdirSync(backendDir);
		writeFileSync(
			path.join(env.userData, "settings.json"),
			JSON.stringify({ autoBuildPath: backendDir }),
		);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		rmSync(env.userData, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	describe("packaged: the file lives under userData, which Python never reads", () => {
		beforeEach(() => {
			env.dev = false;
		});

		it("writes the token encrypted, 0600, and reads it back decrypted", async () => {
			const { update, get, check, status } = await register();
			const envFile = path.join(env.userData, "backend", ".env");

			expect(await update({ claudeOAuthToken: TOKEN })).toEqual({
				success: true,
			});

			expect(readFileSync(envFile, "utf-8")).not.toContain(TOKEN);
			expect(tokenLine(envFile)).toBe(
				`CLAUDE_CODE_OAUTH_TOKEN=${fakeEncrypted(TOKEN)}`,
			);
			if (!isWindows) expect(statSync(envFile).mode & 0o777).toBe(0o600);
			expect(status().secretsAtRisk).toBe(false);

			const read = await get();
			expect(read.data).toMatchObject({
				hasClaudeToken: true,
				claudeOAuthToken: TOKEN,
				envExists: true,
			});
			expect((await check()).data).toMatchObject({ hasToken: true });
		});

		it("hands the saved token, decrypted, to the backend's subprocesses", async () => {
			const { update } = await register();
			await update({ claudeOAuthToken: TOKEN });

			// One of the four readers that build a backend subprocess environment
			const { InsightsConfig } = await import("../insights/config");
			const insights = new InsightsConfig();
			insights.configure(undefined, backendDir);

			expect(insights.loadAutoBuildEnv()).toMatchObject({
				CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
			});
		});

		it("never hands the renderer ciphertext it cannot decrypt", async () => {
			const { update, get } = await register();
			await update({ claudeOAuthToken: TOKEN });
			fake.state.failDecrypt = true;

			const read = await get();
			expect(read.data).toMatchObject({ hasClaudeToken: false });
			expect(read.data?.claudeOAuthToken).toBeUndefined();
		});
	});

	describe("from source: the file is the backend's .env, which Python loads", () => {
		beforeEach(() => {
			env.dev = true;
		});

		it("keeps the token readable by Python, 0600, and names its key to the UI", async () => {
			const { update, get, status } = await register();
			const envFile = path.join(backendDir, ".env");

			expect(await update({ claudeOAuthToken: TOKEN })).toEqual({
				success: true,
			});

			expect(tokenLine(envFile)).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`);
			if (!isWindows) expect(statSync(envFile).mode & 0o777).toBe(0o600);
			expect(status()).toMatchObject({
				secretsAtRisk: true,
				readableSecretKeys: ["CLAUDE_CODE_OAUTH_TOKEN"],
			});
			expect((await get()).data).toMatchObject({ claudeOAuthToken: TOKEN });
		});
	});

	it("revalidates the token: a string on one line, or nothing is written", async () => {
		env.dev = true;
		const { update } = await register();
		const envFile = path.join(backendDir, ".env");

		for (const claudeOAuthToken of [
			`${TOKEN}\nEXTRA=1`,
			`${TOKEN}\rEXTRA=1`,
			// A line break for Python's str.splitlines(), not for parseEnvFile
			`${TOKEN}\u2028EXTRA=1`,
			`${TOKEN}\0`,
			{ toString: () => TOKEN },
		]) {
			const result = await update({ claudeOAuthToken });
			expect(result.success).toBe(false);
		}
		expect(existsSync(envFile)).toBe(false);
	});
});
