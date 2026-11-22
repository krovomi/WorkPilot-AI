/**
 * The custom devices and personas channels (#383): a device arrives described
 * and every field is checked before the main keeps it; a persona arrives as a
 * name only, its cookies read by the main from the preview for the server it
 * launched. Ids are the main's own; refusals are codes, never a message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>());
const service = vi.hoisted(() => ({ url: "http://localhost:5173" as string | null }));
const library = vi.hoisted(() => ({ list: vi.fn(), add: vi.fn(), remove: vi.fn() }));
const personas = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn() }));

vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, handler: (event: unknown, raw?: unknown) => Promise<unknown>) =>
			handlers.set(channel, handler),
	},
}));
vi.mock("../../app-emulator-service", () => ({ appEmulatorService: { getUrl: () => service.url } }));
vi.mock("../../device-matrix/custom-devices", () => {
	class CustomDeviceFailure extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	}
	return {
		CustomDeviceFailure,
		listCustomDevices: (...args: unknown[]) => library.list(...args),
		addCustomDevice: (...args: unknown[]) => library.add(...args),
		removeCustomDevice: (...args: unknown[]) => library.remove(...args),
	};
});
vi.mock("../../device-matrix/personas", () => {
	class PersonaFailure extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	}
	return {
		PersonaFailure,
		listPersonas: (...args: unknown[]) => personas.list(...args),
		savePersona: (...args: unknown[]) => personas.save(...args),
		deletePersona: (...args: unknown[]) => personas.remove(...args),
	};
});

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { CustomDeviceFailure } from "../../device-matrix/custom-devices";
import { PersonaFailure } from "../../device-matrix/personas";
import { httpOrigin, registerDeviceLibraryHandlers } from "../device-library-handlers";

registerDeviceLibraryHandlers();
const call = (channel: string, raw?: unknown) => {
	const handler = handlers.get(channel);
	if (!handler) throw new Error("handler not registered");
	return handler({}, raw);
};

const draft = {
	name: "Kiosk",
	width: 1366,
	height: 768,
	deviceScaleFactor: 1,
	mobile: false,
	touch: true,
	userAgent: "Mozilla/5.0 Kiosk",
};
const CUSTOM = "custom-11111111-2222-4333-8444-555555555555";
const PERSONA = "persona-11111111-2222-4333-8444-555555555555";
const summary = { id: PERSONA, name: "Admin", host: "http://localhost", cookieCount: 2, savedAt: 1 };

describe("custom device channels", () => {
	beforeEach(() => {
		library.list = vi.fn(async () => []);
		library.add = vi.fn(async () => [{ id: CUSTOM, category: "desktop", ...draft }]);
		library.remove = vi.fn(async () => []);
	});

	it("lists, adds a device read in its bounds, and removes by id", async () => {
		expect(await call(IPC_CHANNELS.APP_EMULATOR_LIST_CUSTOM_DEVICES)).toEqual({ success: true, data: [] });
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE, { ...draft, name: " Kiosk ", id: "pixel-8" })).toEqual({
			success: true,
			data: [{ id: CUSTOM, category: "desktop", ...draft }],
		});
		expect(library.add).toHaveBeenCalledWith(draft);
		expect(await call(IPC_CHANNELS.APP_EMULATOR_DELETE_CUSTOM_DEVICE, { id: CUSTOM })).toEqual({ success: true, data: [] });
		expect(library.remove).toHaveBeenCalledWith(CUSTOM);
	});

	it("refuses a device out of bounds, or an id the main never gave, before touching the list", async () => {
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE, { ...draft, width: 10_000 })).toEqual({
			success: false,
			error: "invalid-device",
		});
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE, { ...draft, userAgent: "UA\r\nX-Evil: 1" })).toEqual({
			success: false,
			error: "invalid-device",
		});
		for (const raw of [{ id: "pixel-8" }, { id: "../custom-devices" }, { id: 7 }, "custom-x", null]) {
			expect(await call(IPC_CHANNELS.APP_EMULATOR_DELETE_CUSTOM_DEVICE, raw)).toEqual({
				success: false,
				error: "invalid-request",
			});
		}
		expect(library.add).not.toHaveBeenCalled();
		expect(library.remove).not.toHaveBeenCalled();
	});

	it("names a failure, and hides any other error behind write-failed", async () => {
		library.add = vi.fn(async () => {
			throw new CustomDeviceFailure("too-many");
		});
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_CUSTOM_DEVICE, draft)).toEqual({ success: false, error: "too-many" });
		library.list = vi.fn(async () => {
			throw new Error("EACCES /home/someone/.config");
		});
		expect(await call(IPC_CHANNELS.APP_EMULATOR_LIST_CUSTOM_DEVICES)).toEqual({ success: false, error: "write-failed" });
	});
});

describe("persona channels", () => {
	beforeEach(() => {
		service.url = "http://localhost:5173";
		personas.list = vi.fn(async () => [summary]);
		personas.save = vi.fn(async () => [summary]);
		personas.remove = vi.fn(async () => []);
	});

	it("saves under a name the preview's cookies for the emulator's own origin", async () => {
		service.url = "http://localhost:5173/some/page";
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, { name: " Admin ", origin: "https://bank.example" })).toEqual({
			success: true,
			data: [summary],
		});
		expect(personas.save).toHaveBeenCalledWith("Admin", "http://localhost:5173");
		expect(await call(IPC_CHANNELS.APP_EMULATOR_LIST_PERSONAS)).toEqual({ success: true, data: [summary] });
		expect(await call(IPC_CHANNELS.APP_EMULATOR_DELETE_PERSONA, { id: PERSONA })).toEqual({ success: true, data: [] });
		expect(personas.remove).toHaveBeenCalledWith(PERSONA);
	});

	it("refuses a bad name, a bad id, or no server, before reading any cookie", async () => {
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, { name: "" })).toEqual({
			success: false,
			error: "invalid-request",
		});
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, "Admin")).toEqual({ success: false, error: "invalid-request" });
		expect(await call(IPC_CHANNELS.APP_EMULATOR_DELETE_PERSONA, { id: "custom-x" })).toEqual({
			success: false,
			error: "invalid-request",
		});
		service.url = null;
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, { name: "Admin" })).toEqual({
			success: false,
			error: "not-running",
		});
		service.url = "file:///etc/passwd";
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, { name: "Admin" })).toEqual({
			success: false,
			error: "not-running",
		});
		expect(personas.save).not.toHaveBeenCalled();
		expect(personas.remove).not.toHaveBeenCalled();
	});

	it("names a failure, and hides any other error behind write-failed", async () => {
		personas.save = vi.fn(async () => {
			throw new PersonaFailure("encryption-unavailable");
		});
		expect(await call(IPC_CHANNELS.APP_EMULATOR_SAVE_PERSONA, { name: "Admin" })).toEqual({
			success: false,
			error: "encryption-unavailable",
		});
		personas.list = vi.fn(async () => {
			throw new Error("keyring said: something private");
		});
		expect(await call(IPC_CHANNELS.APP_EMULATOR_LIST_PERSONAS)).toEqual({ success: false, error: "write-failed" });
	});
});

describe("httpOrigin", () => {
	it("keeps the origin of an http(s) server only", () => {
		expect(httpOrigin("https://localhost:7001/swagger")).toBe("https://localhost:7001");
		expect(httpOrigin("ftp://localhost")).toBeNull();
		expect(httpOrigin("not a url")).toBeNull();
	});
});
