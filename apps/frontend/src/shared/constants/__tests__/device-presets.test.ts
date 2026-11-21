/**
 * The device matrix catalogue (#383): ids are unique and named in both
 * languages, and only a catalogue id is ever emulated.
 */
import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en/appEmulator.json";
import fr from "../../i18n/locales/fr/appEmulator.json";
import {
	DEFAULT_MATRIX_DEVICE_IDS,
	DEVICE_ORIENTATIONS,
	DEVICE_PRESETS,
	findDevicePreset,
	findOrientation,
	isRotated,
	orientDevice,
	orientationOf,
} from "../device-presets";

describe("device presets", () => {
	it("has unique ids, sane metrics and a name in en and fr", () => {
		const ids = DEVICE_PRESETS.map((device) => device.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const device of DEVICE_PRESETS) {
			expect(device.width).toBeGreaterThan(0);
			expect(device.height).toBeGreaterThan(0);
			expect(device.deviceScaleFactor).toBeGreaterThanOrEqual(1);
			expect(device.userAgent).toMatch(/^Mozilla\/5\.0 /);
			expect((en.devices as Record<string, string>)[device.id]).toBeTruthy();
			expect((fr.devices as Record<string, string>)[device.id]).toBeTruthy();
		}
	});

	it("covers phones, tablets, desktops and a TV, touch where it should", () => {
		const categories = new Set(DEVICE_PRESETS.map((device) => device.category));
		expect([...categories].sort()).toEqual(["desktop", "phone", "tablet", "tv"]);
		for (const device of DEVICE_PRESETS) {
			const handheld = device.category === "phone" || device.category === "tablet";
			expect(device.touch).toBe(handheld);
			expect(device.mobile).toBe(handheld);
		}
	});

	it("checks by default only devices of the catalogue", () => {
		for (const id of DEFAULT_MATRIX_DEVICE_IDS) expect(findDevicePreset(id)).toBeDefined();
	});

	it("finds a preset by id and nothing else", () => {
		expect(findDevicePreset("pixel-8")?.width).toBe(412);
		expect(findDevicePreset("pixel-80")).toBeUndefined();
		expect(findDevicePreset({ id: "pixel-8" })).toBeUndefined();
		expect(findDevicePreset(undefined)).toBeUndefined();
	});
});

describe("orientation", () => {
	const iphone = findDevicePreset("iphone-15");
	const desktop = findDevicePreset("desktop-1080p");
	if (!iphone || !desktop) throw new Error("presets missing");

	it("knows portrait and landscape, and nothing else", () => {
		expect(DEVICE_ORIENTATIONS).toEqual(["portrait", "landscape"]);
		expect(findOrientation("landscape")).toBe("landscape");
		expect(findOrientation("upside-down")).toBeUndefined();
		expect(findOrientation(1)).toBeUndefined();
	});

	it("swaps the viewport only when a handheld is turned away from its own orientation", () => {
		expect(orientationOf(iphone)).toBe("portrait");
		expect(orientDevice(iphone, "portrait")).toBe(iphone);
		const turned = orientDevice(iphone, "landscape");
		expect([turned.width, turned.height]).toEqual([852, 393]);
		expect(isRotated(turned)).toBe(true);
		expect(isRotated(iphone)).toBe(false);
		const tablet = findDevicePreset("ipad-mini");
		expect(tablet && orientDevice(tablet, "landscape").width).toBe(1024);
	});

	it("never turns a desktop or a TV", () => {
		expect(orientDevice(desktop, "portrait")).toBe(desktop);
		expect(orientDevice(desktop, "landscape")).toBe(desktop);
	});

	it("reads an unknown device by its own viewport", () => {
		expect(isRotated({ ...iphone, id: "custom", width: 900, height: 400 })).toBe(false);
		expect(isRotated({ ...desktop, width: 1080, height: 1920 })).toBe(true);
	});
});
