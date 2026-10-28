import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	installIpcSenderPolicy,
	isTrustedSender,
	resetIpcSenderPolicyForTests,
	SENDER_REFUSED,
} from "./ipc-sender-policy";

function windowAt(url: string) {
	const mainFrame = { url };
	const webContents = { mainFrame };
	return { webContents, mainFrame };
}

function eventFrom(
	webContents: { mainFrame: unknown },
	frame: { url: string } | null,
) {
	return { sender: webContents, senderFrame: frame };
}

describe("isTrustedSender", () => {
	const packaged = windowAt("file:///opt/WorkPilot/resources/renderer/index.html#/");
	const policy = { getMainWindow: () => packaged };

	it("accepts the app page in the main window's top frame", () => {
		const event = eventFrom(packaged.webContents, packaged.mainFrame);
		expect(isTrustedSender(event, policy)).toBe(true);
	});

	it("refuses another webContents", () => {
		const other = windowAt("file:///opt/WorkPilot/resources/renderer/index.html");
		const event = eventFrom(other.webContents, other.mainFrame);
		expect(isTrustedSender(event, policy)).toBe(false);
	});

	it("refuses a subframe of the main window", () => {
		const event = eventFrom(packaged.webContents, { url: "file:///x.html" });
		expect(isTrustedSender(event, policy)).toBe(false);
	});

	it("refuses a frame that is already gone", () => {
		const event = eventFrom(packaged.webContents, null);
		expect(isTrustedSender(event, policy)).toBe(false);
	});

	it("refuses everything before the main window exists", () => {
		const event = eventFrom(packaged.webContents, packaged.mainFrame);
		expect(isTrustedSender(event, { getMainWindow: () => null })).toBe(false);
	});

	it("refuses a remote page loaded in the main window", () => {
		const hijacked = windowAt("https://attacker.example/");
		const event = eventFrom(hijacked.webContents, hijacked.mainFrame);
		expect(isTrustedSender(event, { getMainWindow: () => hijacked })).toBe(
			false,
		);
	});

	it("accepts only the dev server's origin while developing", () => {
		const dev = windowAt("http://localhost:5173/#/kanban");
		const devPolicy = {
			getMainWindow: () => dev,
			devServerUrl: "http://localhost:5173",
		};
		expect(
			isTrustedSender(eventFrom(dev.webContents, dev.mainFrame), devPolicy),
		).toBe(true);

		const elsewhere = windowAt("http://localhost:8080/");
		expect(
			isTrustedSender(eventFrom(elsewhere.webContents, elsewhere.mainFrame), {
				...devPolicy,
				getMainWindow: () => elsewhere,
			}),
		).toBe(false);
		const file = windowAt("file:///tmp/page.html");
		expect(
			isTrustedSender(eventFrom(file.webContents, file.mainFrame), {
				...devPolicy,
				getMainWindow: () => file,
			}),
		).toBe(false);
	});
});

describe("installIpcSenderPolicy", () => {
	type Listener = (event: unknown, ...args: unknown[]) => unknown;
	let handlers: Map<string, Listener>;
	let listeners: Map<string, Listener>;
	let ipc: {
		handle: (channel: string, listener: Listener) => void;
		on: (channel: string, listener: Listener) => void;
	};
	const app = windowAt("file:///opt/WorkPilot/resources/renderer/index.html");

	beforeEach(() => {
		resetIpcSenderPolicyForTests();
		handlers = new Map();
		listeners = new Map();
		ipc = {
			handle: (channel, listener) => handlers.set(channel, listener),
			on: (channel, listener) => listeners.set(channel, listener),
		};
		// biome-ignore lint/suspicious/noExplicitAny: a fake of ipcMain
		installIpcSenderPolicy(ipc as any, { getMainWindow: () => app });
	});

	it("runs a handler for the app page and never for another sender", async () => {
		const handler = vi.fn(() => "ran");
		ipc.handle("project:list", handler);
		const wrapped = handlers.get("project:list") as Listener;

		expect(await wrapped(eventFrom(app.webContents, app.mainFrame), 1)).toBe(
			"ran",
		);
		expect(handler).toHaveBeenCalledWith(
			expect.anything(),
			1,
		);

		handler.mockClear();
		const stranger = windowAt("file:///opt/WorkPilot/resources/renderer/index.html");
		expect(
			await wrapped(eventFrom(stranger.webContents, stranger.mainFrame)),
		).toEqual({ success: false, error: SENDER_REFUSED });
		expect(handler).not.toHaveBeenCalled();
	});

	it("drops a message from another sender", () => {
		const listener = vi.fn();
		ipc.on("terminal:input", listener);
		const wrapped = listeners.get("terminal:input") as Listener;

		wrapped(eventFrom(app.webContents, { url: "file:///frame.html" }), "ls");
		expect(listener).not.toHaveBeenCalled();
		wrapped(eventFrom(app.webContents, app.mainFrame), "ls");
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("ipc-setup.ts", () => {
	it("installs the sender check before the directory check and any handler", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const source = readFileSync(resolve(__dirname, "..", "ipc-setup.ts"), "utf-8");
		const sender = source.indexOf("installIpcSenderPolicy(ipcMain");
		const paths = source.indexOf("installIpcPathPolicy(ipcMain");
		const handlers = source.indexOf("setupModularHandlers(\n");
		expect(sender).toBeGreaterThan(-1);
		expect(sender).toBeLessThan(paths);
		expect(paths).toBeLessThan(handlers);
	});
});
