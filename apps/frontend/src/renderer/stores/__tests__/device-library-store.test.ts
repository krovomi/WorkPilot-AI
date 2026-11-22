/**
 * The custom devices and personas as the renderer sees them (#383): read once
 * from the main, quietly; every change goes through the main and the list it
 * answers replaces the one shown; a refusal is kept to be said.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDeviceLibraryStore } from "../device-library-store";

const api = {
	listEmulatorCustomDevices: vi.fn(),
	saveEmulatorCustomDevice: vi.fn(),
	deleteEmulatorCustomDevice: vi.fn(),
	listEmulatorPersonas: vi.fn(),
	saveEmulatorPersona: vi.fn(),
	deleteEmulatorPersona: vi.fn(),
};
Object.defineProperty(globalThis, "electronAPI", { value: api, writable: true });

const device = {
	id: "custom-11111111-2222-4333-8444-555555555555",
	name: "Kiosk",
	category: "desktop" as const,
	width: 1366,
	height: 768,
	deviceScaleFactor: 1,
	mobile: false,
	touch: true,
	userAgent: "UA",
};
const admin = { id: "persona-1", name: "Admin", host: "http://localhost", cookieCount: 2, savedAt: 1 };
const guest = { ...admin, id: "persona-2", name: "Guest" };

describe("useDeviceLibraryStore", () => {
	beforeEach(() => {
		for (const fn of Object.values(api)) fn.mockReset();
		useDeviceLibraryStore.setState({ customDevices: [], personas: [], loaded: false, saving: false, problem: null });
	});

	it("loads both lists once", async () => {
		api.listEmulatorCustomDevices.mockResolvedValue({ success: true, data: [device] });
		api.listEmulatorPersonas.mockResolvedValue({ success: true, data: [admin] });
		await useDeviceLibraryStore.getState().load();
		await useDeviceLibraryStore.getState().load();
		expect(useDeviceLibraryStore.getState()).toMatchObject({ customDevices: [device], personas: [admin], problem: null });
		expect(api.listEmulatorCustomDevices).toHaveBeenCalledTimes(1);
	});

	it("adds and removes a device through the main, and keeps a refusal to say", async () => {
		api.saveEmulatorCustomDevice.mockResolvedValueOnce({ success: true, data: [device] });
		expect(await useDeviceLibraryStore.getState().addDevice(device)).toBe(true);
		expect(useDeviceLibraryStore.getState().customDevices).toEqual([device]);
		api.saveEmulatorCustomDevice.mockResolvedValueOnce({ success: false, error: "too-many" });
		expect(await useDeviceLibraryStore.getState().addDevice(device)).toBe(false);
		expect(useDeviceLibraryStore.getState().problem).toEqual({ scope: "device", error: "too-many" });
		api.deleteEmulatorCustomDevice.mockRejectedValueOnce(new Error("bridge gone"));
		await useDeviceLibraryStore.getState().removeDevice(device.id);
		expect(useDeviceLibraryStore.getState()).toMatchObject({
			customDevices: [device],
			saving: false,
			problem: { scope: "device", error: "write-failed" },
		});
		api.deleteEmulatorCustomDevice.mockResolvedValueOnce({ success: true, data: [] });
		await useDeviceLibraryStore.getState().removeDevice(device.id);
		expect(api.deleteEmulatorCustomDevice).toHaveBeenLastCalledWith(device.id);
		expect(useDeviceLibraryStore.getState()).toMatchObject({ customDevices: [], problem: null });
	});

	it("saves a persona and gives back the id the main made for it", async () => {
		useDeviceLibraryStore.setState({ personas: [admin] });
		api.saveEmulatorPersona.mockResolvedValueOnce({ success: true, data: [admin, guest] });
		expect(await useDeviceLibraryStore.getState().savePersona("Guest")).toBe("persona-2");
		expect(api.saveEmulatorPersona).toHaveBeenCalledWith("Guest");
		api.saveEmulatorPersona.mockResolvedValueOnce({ success: false, error: "encryption-unavailable" });
		expect(await useDeviceLibraryStore.getState().savePersona("Other")).toBeNull();
		expect(useDeviceLibraryStore.getState().problem).toEqual({ scope: "persona", error: "encryption-unavailable" });
		api.saveEmulatorPersona.mockRejectedValueOnce(new Error("bridge gone"));
		expect(await useDeviceLibraryStore.getState().savePersona("Other")).toBeNull();
		expect(useDeviceLibraryStore.getState().problem).toEqual({ scope: "persona", error: "write-failed" });
		api.deleteEmulatorPersona.mockResolvedValueOnce({ success: true, data: [guest] });
		await useDeviceLibraryStore.getState().deletePersona("persona-1");
		expect(useDeviceLibraryStore.getState().personas).toEqual([guest]);
	});
});
