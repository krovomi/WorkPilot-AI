/**
 * The bounds of a custom device and of a persona's name (#383): every field
 * in its range or the whole draft is refused, so the main never emulates a
 * window, a density or a user agent outside them, whatever the form let by.
 */
import { describe, expect, it } from "vitest";
import {
	CUSTOM_DEVICE_ID,
	categoryOf,
	customDevice,
	readCustomDeviceDraft,
	readDisplayName,
	readStoredCustomDevice,
} from "../custom-device";

const draft = {
	name: "  Flip 6  ",
	width: 360,
	height: 748,
	deviceScaleFactor: 2.6251,
	mobile: true,
	touch: true,
	userAgent: " Mozilla/5.0 (Linux; Android 14) Mobile ",
};
const ID = "custom-11111111-2222-4333-8444-555555555555";

describe("readDisplayName", () => {
	it("trims a name and keeps 1 to 40 safe characters", () => {
		expect(readDisplayName("  Admin  ")).toBe("Admin");
		expect(readDisplayName("Client sans commande")).toBe("Client sans commande");
		expect(readDisplayName("x".repeat(40))).toHaveLength(40);
	});

	it.each([
		["not a string", 42],
		["empty", "   "],
		["too long", "x".repeat(41)],
		["a control character", "Admin\u0007"],
		["a line break", "Admin\nRoot"],
		["a C1 control", "Admin\u0085"],
		["a right-to-left override", "Admin‮"],
		["a direction isolate", "⁦Admin"],
		["a direction mark", "Admin‏"],
	])("refuses %s", (_label, value) => {
		expect(readDisplayName(value)).toBeNull();
	});
});

describe("readCustomDeviceDraft", () => {
	it("keeps a draft in its bounds, trimmed, its density rounded", () => {
		expect(readCustomDeviceDraft({ ...draft, id: "desktop-1080p" })).toEqual({
			name: "Flip 6",
			width: 360,
			height: 748,
			deviceScaleFactor: 2.625,
			mobile: true,
			touch: true,
			userAgent: "Mozilla/5.0 (Linux; Android 14) Mobile",
		});
		expect(readCustomDeviceDraft({ ...draft, width: 240, height: 3840, deviceScaleFactor: 4 })).not.toBeNull();
	});

	it.each([
		["nothing", null],
		["a string", "Flip"],
		["a bad name", { ...draft, name: "" }],
		["a narrow window", { ...draft, width: 239 }],
		["a huge window", { ...draft, height: 3841 }],
		["a fractional width", { ...draft, width: 360.5 }],
		["a width as text", { ...draft, width: "360" }],
		["a density below 1", { ...draft, deviceScaleFactor: 0.5 }],
		["a density above 4", { ...draft, deviceScaleFactor: 5 }],
		["an infinite density", { ...draft, deviceScaleFactor: Number.POSITIVE_INFINITY }],
		["a density as text", { ...draft, deviceScaleFactor: "2" }],
		["an empty user agent", { ...draft, userAgent: "  " }],
		["a user agent as a number", { ...draft, userAgent: 5 }],
		["a header injection", { ...draft, userAgent: "UA\r\nCookie: sid=test-0000" }],
		["a non-ASCII user agent", { ...draft, userAgent: "Mozillä" }],
		["an overlong user agent", { ...draft, userAgent: "x".repeat(513) }],
		["mobile as text", { ...draft, mobile: "yes" }],
		["no touch flag", { ...draft, touch: undefined }],
	])("refuses %s", (_label, raw) => {
		expect(readCustomDeviceDraft(raw)).toBeNull();
	});
});

describe("categoryOf and customDevice", () => {
	it("files a device by its browser and its narrow side", () => {
		expect(categoryOf({ width: 360, height: 748, mobile: true })).toBe("phone");
		expect(categoryOf({ width: 1180, height: 820, mobile: true })).toBe("tablet");
		expect(categoryOf({ width: 375, height: 667, mobile: false })).toBe("desktop");
	});

	it("builds the emulated device from a draft already read", () => {
		const read = readCustomDeviceDraft(draft);
		if (!read) throw new Error("draft refused");
		expect(customDevice(ID, read)).toMatchObject({ id: ID, category: "phone", name: "Flip 6", width: 360 });
	});
});

describe("readStoredCustomDevice", () => {
	it("keeps an entry with an id from the main and a draft in its bounds", () => {
		expect(CUSTOM_DEVICE_ID.test(ID)).toBe(true);
		expect(readStoredCustomDevice({ ...draft, id: ID })).toMatchObject({ id: ID, name: "Flip 6" });
	});

	it("drops anything else", () => {
		expect(readStoredCustomDevice(null)).toBeNull();
		expect(readStoredCustomDevice({ ...draft, id: "desktop-1080p" })).toBeNull();
		expect(readStoredCustomDevice({ ...draft, id: 7 })).toBeNull();
		expect(readStoredCustomDevice({ ...draft, id: ID, width: 99_999 })).toBeNull();
	});
});
