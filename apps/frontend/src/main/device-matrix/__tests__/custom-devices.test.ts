/**
 * The custom devices the main keeps (#383), on a real folder: an id from the
 * main, a file under the app's folder written whole, a re-read that drops
 * what is out of bounds, a cap, and a lookup that serves the catalogue first.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const folder = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => folder.userData } }));

import { isWindows } from "../../platform";
import { CUSTOM_DEVICE_LIMITS } from "../../../shared/utils/custom-device";
import {
	CustomDeviceFailure,
	addCustomDevice,
	findDevice,
	forgetCustomDevices,
	listCustomDevices,
	removeCustomDevice,
} from "../custom-devices";
import { libraryPath, readLibrary } from "../library-file";

const draft = {
	name: "Kiosk",
	width: 1366,
	height: 768,
	deviceScaleFactor: 1,
	mobile: false,
	touch: true,
	userAgent: "Mozilla/5.0 (X11; Linux x86_64) Kiosk",
};
const file = () => libraryPath("custom-devices");

describe("custom devices", () => {
	beforeEach(() => {
		folder.userData = mkdtempSync(path.join(tmpdir(), "device-matrix-"));
		forgetCustomDevices();
	});

	afterEach(() => {
		rmSync(folder.userData, { recursive: true, force: true });
	});

	it("starts empty, then keeps a device under an id of its own, on disk", async () => {
		expect(await listCustomDevices()).toEqual([]);
		const [kiosk] = await addCustomDevice(draft);
		expect(kiosk).toMatchObject({ category: "desktop", name: "Kiosk", width: 1366 });
		expect(kiosk.id).toMatch(/^custom-[0-9a-f-]{36}$/);
		expect(file()).toBe(path.join(folder.userData, "device-matrix", "custom-devices.json"));
		expect(JSON.parse(readFileSync(file(), "utf-8")).entries).toEqual([kiosk]);
		forgetCustomDevices();
		expect(await listCustomDevices()).toEqual([kiosk]);
		expect(await findDevice(kiosk.id)).toEqual(kiosk);
	});

	it("serves the catalogue first, and nothing for an unknown id", async () => {
		expect(await findDevice("pixel-8")).toMatchObject({ id: "pixel-8" });
		expect(await findDevice("custom-unknown")).toBeUndefined();
		expect(await findDevice(42)).toBeUndefined();
	});

	it("removes a device, and names an id it does not know", async () => {
		const [kiosk] = await addCustomDevice(draft);
		expect(await removeCustomDevice(kiosk.id)).toEqual([]);
		await expect(removeCustomDevice(kiosk.id)).rejects.toMatchObject({ code: "unknown-device" });
	});

	it("refuses a device past the cap, and keeps the list as it was", async () => {
		for (let index = 0; index < CUSTOM_DEVICE_LIMITS.maxDevices; index++) await addCustomDevice(draft);
		const error = await addCustomDevice(draft).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(CustomDeviceFailure);
		expect(error).toMatchObject({ code: "too-many" });
		expect(await listCustomDevices()).toHaveLength(CUSTOM_DEVICE_LIMITS.maxDevices);
	});

	it("drops, on a re-read, every entry a hand edit pushed out of bounds", async () => {
		mkdirSync(path.dirname(file()), { recursive: true });
		const id = "custom-11111111-2222-4333-8444-555555555555";
		writeFileSync(
			file(),
			JSON.stringify({
				entries: [
					{ ...draft, id },
					{ ...draft, id: "custom-22222222-2222-4333-8444-555555555555", width: 99_999 },
					{ ...draft, id: "pixel-8" },
					"not a device",
				],
			}),
		);
		expect((await listCustomDevices()).map((device) => device.id)).toEqual([id]);
	});

	it("reads an unreadable or misshapen file as no device", async () => {
		mkdirSync(path.dirname(file()), { recursive: true });
		writeFileSync(file(), "{ not json");
		expect(await readLibrary("custom-devices", () => 1, 5)).toEqual([]);
		writeFileSync(file(), JSON.stringify({ entries: "many" }));
		expect(await readLibrary("custom-devices", () => 1, 5)).toEqual([]);
		writeFileSync(file(), "null");
		expect(await readLibrary("custom-devices", () => 1, 5)).toEqual([]);
	});

	it("names a list it cannot write, and stays usable after", async () => {
		// A file where the folder should be: the write fails.
		writeFileSync(path.join(folder.userData, "device-matrix"), "");
		await expect(addCustomDevice(draft)).rejects.toMatchObject({ code: "write-failed" });
		rmSync(path.join(folder.userData, "device-matrix"));
		expect(await addCustomDevice(draft)).toHaveLength(1);
		// Windows has no owner-only bits to read.
		if (!isWindows()) expect(statSync(file()).mode & 0o077).toBe(0);
	});
});
