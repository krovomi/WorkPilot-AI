import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const exit = vi.fn();
const quit = vi.fn();
vi.mock("electron", () => ({
	app: {
		exit: (code: number) => exit(code),
		quit: () => quit(),
		getVersion: () => "9.9.9",
	},
}));

import {
	armSmokeTest,
	isSmokeTest,
	SMOKE_TEST_ENV,
	waitForMountedRoot,
} from "../smoke-test";

function fakeWindow(probe: () => Promise<unknown>) {
	const contents = Object.assign(new EventEmitter(), {
		executeJavaScript: probe,
	});
	// biome-ignore lint/suspicious/noExplicitAny: a BrowserWindow stand-in
	return { window: { webContents: contents } as any, contents };
}

afterEach(() => {
	delete process.env[SMOKE_TEST_ENV];
	exit.mockReset();
	quit.mockReset();
	vi.restoreAllMocks();
});

describe("isSmokeTest", () => {
	it("is on only for the exact value 1", () => {
		expect(isSmokeTest({ [SMOKE_TEST_ENV]: "1" })).toBe(true);
		expect(isSmokeTest({ [SMOKE_TEST_ENV]: "true" })).toBe(false);
		expect(isSmokeTest({})).toBe(false);
	});
});

describe("waitForMountedRoot", () => {
	it("answers true once the root has children", async () => {
		const answers = [0, 0, 3];
		const probe = vi.fn(async () => answers.shift() ?? 3);
		await expect(waitForMountedRoot(probe, 1_000, 1)).resolves.toBe(true);
		expect(probe).toHaveBeenCalledTimes(3);
	});

	it("answers false when the root stays empty", async () => {
		await expect(waitForMountedRoot(async () => 0, 20, 1)).resolves.toBe(false);
	});

	it("reads a probe that throws as an empty root, not a crash", async () => {
		const probe = async () => {
			throw new Error("page gone");
		};
		await expect(waitForMountedRoot(probe, 20, 1)).resolves.toBe(false);
	});
});

describe("armSmokeTest", () => {
	it("does nothing without the environment variable", () => {
		const { window, contents } = fakeWindow(async () => 1);
		armSmokeTest(window);
		expect(contents.listenerCount("did-finish-load")).toBe(0);
	});

	// app.exit() skipped before-quit and will-quit: the startup work kept
	// running while the main process tore down, and it died with SIGILL (F134).
	it("quits like a user once the renderer has mounted", async () => {
		process.env[SMOKE_TEST_ENV] = "1";
		vi.spyOn(process.stdout, "write").mockImplementation(((
			_line: string,
			done?: () => void,
		) => {
			done?.();
			return true;
		}) as typeof process.stdout.write);
		const { window, contents } = fakeWindow(async () => 2);
		armSmokeTest(window);
		contents.emit("did-finish-load");
		await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
		expect(exit).not.toHaveBeenCalled();
	});

	it("exits 1 when the renderer process goes away", () => {
		process.env[SMOKE_TEST_ENV] = "1";
		vi.spyOn(process.stderr, "write").mockImplementation(((
			_line: string,
			done?: () => void,
		) => {
			done?.();
			return true;
		}) as typeof process.stderr.write);
		const { window, contents } = fakeWindow(async () => 0);
		armSmokeTest(window);
		contents.emit("render-process-gone", {}, { reason: "crashed" });
		expect(exit).toHaveBeenCalledWith(1);
		expect(quit).not.toHaveBeenCalled();
	});
});
