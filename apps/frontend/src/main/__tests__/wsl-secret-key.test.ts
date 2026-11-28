/**
 * @vitest-environment node
 *
 * The WSL secrets key (wsl-secret-key.ts): on disk only wrapped by Windows
 * DPAPI, created once, never replaced while a blob is there, never used
 * unless DPAPI gives it back.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLinux } from "../platform";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent" } }));

type Module = typeof import("../wsl-secret-key");
// The test setup stubs loadWslSecretKey for every other suite.
const actual = await vi.importActual<Module>("../wsl-secret-key");
const { loadWslSecretKey, powershellPath, runDpapi, encodedDpapiScript } =
	actual;

const KEY = Buffer.alloc(32, 7);
/** A stand-in for DPAPI: "wrapping" prefixes a marker, unwrapping checks it. */
const MARK = Buffer.from("dpapi:");

function fakeDeps(overrides: Partial<Parameters<typeof loadWslSecretKey>[1]> = {}) {
	const files = new Map<string, string>();
	const deps = {
		wsl: true,
		keyFile: "/profile/secret-key.dpapi",
		dpapi: vi.fn(async (mode: "protect" | "unprotect", data: Buffer) => {
			if (mode === "protect") return Buffer.concat([MARK, data]);
			if (!data.subarray(0, MARK.length).equals(MARK)) return null;
			return data.subarray(MARK.length);
		}),
		readKeyFile: vi.fn(async (file: string) => files.get(file) ?? null),
		createKeyFile: vi.fn(async (file: string, content: string) => {
			if (files.has(file)) return false;
			files.set(file, content);
			return true;
		}),
		random: vi.fn(() => Buffer.from(KEY)),
	};
	return { deps: { ...deps, ...overrides } as typeof deps, files };
}

describe("loadWslSecretKey", () => {
	it("does nothing outside WSL", async () => {
		const { deps } = fakeDeps({ wsl: false });

		expect(await loadWslSecretKey({ create: true }, deps)).toBeNull();
		expect(deps.readKeyFile).not.toHaveBeenCalled();
		expect(deps.dpapi).not.toHaveBeenCalled();
	});

	it("creates the key once, stored only wrapped by DPAPI", async () => {
		const { deps, files } = fakeDeps();

		const key = await loadWslSecretKey({ create: true }, deps);

		expect(key?.equals(KEY)).toBe(true);
		const stored = files.get(deps.keyFile) ?? "";
		expect(Buffer.from(stored, "base64").subarray(0, MARK.length)).toEqual(MARK);
		expect(stored).not.toBe(KEY.toString("base64"));
		// Next launch: unwrapped from the file, no new key.
		deps.random.mockClear();
		const again = await loadWslSecretKey({ create: true }, deps);
		expect(again?.equals(KEY)).toBe(true);
		expect(deps.random).not.toHaveBeenCalled();
	});

	it("creates nothing when not asked to", async () => {
		const { deps, files } = fakeDeps();

		expect(await loadWslSecretKey({ create: false }, deps)).toBeNull();
		expect(files.size).toBe(0);
		expect(deps.dpapi).not.toHaveBeenCalled();
	});

	it("never replaces a blob it cannot unwrap: the secrets it encrypted need it", async () => {
		const { deps, files } = fakeDeps();
		files.set(deps.keyFile, Buffer.from("other-account-blob").toString("base64"));

		expect(await loadWslSecretKey({ create: true }, deps)).toBeNull();
		expect(deps.createKeyFile).not.toHaveBeenCalled();
		expect(deps.random).not.toHaveBeenCalled();
	});

	it("refuses a key file that is not base64 or holds a key of the wrong size", async () => {
		const { deps, files } = fakeDeps();
		files.set(deps.keyFile, "not base64 !");
		expect(await loadWslSecretKey({ create: true }, deps)).toBeNull();

		files.set(
			deps.keyFile,
			Buffer.concat([MARK, Buffer.alloc(16)]).toString("base64"),
		);
		expect(await loadWslSecretKey({ create: true }, deps)).toBeNull();
	});

	it("without DPAPI, or when it does not give the key back, writes nothing", async () => {
		const none = fakeDeps({ dpapi: vi.fn(async () => null) });
		expect(await loadWslSecretKey({ create: true }, none.deps)).toBeNull();
		expect(none.files.size).toBe(0);

		const wrong = fakeDeps({
			dpapi: vi.fn(async (mode: string, data: Buffer) =>
				mode === "protect" ? data : Buffer.alloc(32, 1),
			),
		});
		expect(await loadWslSecretKey({ create: true }, wrong.deps)).toBeNull();
		expect(wrong.files.size).toBe(0);
	});

	it("uses the key another instance wrote first", async () => {
		const { deps, files } = fakeDeps();
		const winner = Buffer.alloc(32, 9);
		deps.createKeyFile.mockImplementationOnce(async (file: string) => {
			files.set(file, Buffer.concat([MARK, winner]).toString("base64"));
			return false;
		});

		const key = await loadWslSecretKey({ create: true }, deps);

		expect(key?.equals(winner)).toBe(true);
	});
});

describe("powershellPath", () => {
	it("prefers Windows PowerShell on the C: drive WSL mounts", () => {
		const exists = (file: string) =>
			file === "/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
		expect(powershellPath("/win", exists, () => "/elsewhere/powershell.exe")).toBe(
			"/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
		);
	});

	it("falls back to the PATH interop appends, then to nothing", () => {
		expect(powershellPath("/mnt/", () => false, () => "/x/powershell.exe")).toBe(
			"/x/powershell.exe",
		);
		expect(powershellPath("/mnt/", () => false, () => null)).toBeNull();
	});
});

describe("runDpapi", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "wsl-dpapi-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes a fixed script, not the data, as arguments", () => {
		const script = Buffer.from(encodedDpapiScript(), "base64").toString("utf16le");
		expect(script).toContain("ProtectedData");
		expect(script).toContain("CurrentUser");
		expect(script).toContain("[Console]::In.ReadLine()");
	});

	it.runIf(isLinux())(
		"sends the data on stdin, without the app's environment, and reads base64 back",
		async () => {
			// A stand-in for powershell.exe: echoes the data line, fails if it
			// sees the app's secrets or any argument but the fixed ones.
			const fakePowershell = path.join(dir, "powershell.exe");
			writeFileSync(
				fakePowershell,
				[
					"#!/bin/sh",
					'[ -n "$APP_SECRET" ] && exit 3',
					'[ "$WSLENV" = "" ] || exit 4',
					'[ "$4" = "-EncodedCommand" ] || exit 5',
					'[ "$#" = "5" ] || exit 6',
					"read mode",
					"read data",
					'[ "$mode" = "protect" ] || exit 7',
					'printf "%s" "$data"',
				].join("\n"),
			);
			chmodSync(fakePowershell, 0o755);
			const env = { PATH: process.env.PATH, APP_SECRET: "sk-test-0000" };

			const out = await runDpapi(fakePowershell, "protect", KEY, env);

			expect(out?.equals(KEY)).toBe(true);
		},
	);

	it.runIf(isLinux())("answers null when the call fails", async () => {
		const failing = path.join(dir, "powershell.exe");
		writeFileSync(failing, "#!/bin/sh\nexit 1\n");
		chmodSync(failing, 0o755);

		expect(await runDpapi(failing, "unprotect", KEY, {})).toBeNull();
		expect(await runDpapi(path.join(dir, "missing.exe"), "protect", KEY, {})).toBeNull();
	});
});
