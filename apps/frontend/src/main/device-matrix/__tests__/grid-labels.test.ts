/**
 * The captions of the exported grid (#383): written by the main in the app's
 * language from the renderer's own texts, never sent by the renderer.
 */
import { describe, expect, it } from "vitest";
import { findDevicePreset } from "../../../shared/constants/device-presets";
import { findCpuProfile, findNetworkProfile } from "../../../shared/constants/emulation-throttling";
import type { CpuProfile, DevicePreset, NetworkProfile } from "../../../shared/types/device-matrix";
import { gridCaption } from "../grid-labels";

const device = findDevicePreset("desktop-1080p") as DevicePreset;
const network = (id: string) => findNetworkProfile(id) as NetworkProfile;
const cpu = (id: string) => findCpuProfile(id) as CpuProfile;

describe("gridCaption", () => {
	it("names the device and its window, in English by default", () => {
		expect(gridCaption(device, network("none"), cpu("1x"), "en")).toEqual({
			label: "Full HD desktop",
			detail: "1920 × 1080 @1x",
		});
		expect(gridCaption(device, network("none"), cpu("1x"), "de").label).toBe("Full HD desktop");
	});

	it("adds the throttling, in French when the app is in French", () => {
		expect(gridCaption(device, network("slow-3g"), cpu("4x"), "fr")).toEqual({
			label: "Ordinateur Full HD",
			detail: "1920 × 1080 @1x · 3G lente · Processeur 4× plus lent",
		});
		expect(gridCaption(device, network("4g"), cpu("1x"), "en").detail).toBe("1920 × 1080 @1x · 4G");
	});

	it("falls back to the id of a device without a name", () => {
		expect(gridCaption({ ...device, id: "prototype" }, network("none"), cpu("2x"), "en")).toEqual({
			label: "prototype",
			detail: "1920 × 1080 @1x · CPU 2× slower",
		});
	});
});
