import { describe, expect, it } from "vitest";
import {
	acceleratorFromEvent,
	DEFAULT_VOICE_SHORTCUT,
	formatShortcut,
	matchesShortcut,
	parseAccelerator,
	type ShortcutKeyEvent,
	shortcutConflict,
} from "../voice-shortcut";

const key = (over: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
	key: "",
	code: "",
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	metaKey: false,
	...over,
});

describe("the default shortcut", () => {
	it("is free: no app, terminal or menu shortcut uses it", () => {
		expect(shortcutConflict(DEFAULT_VOICE_SHORTCUT)).toBeNull();
	});

	it("reads Ctrl+Shift+Space, or ⇧⌘Space on macOS", () => {
		expect(formatShortcut(DEFAULT_VOICE_SHORTCUT, false)).toBe("Ctrl+Shift+Space");
		expect(formatShortcut(DEFAULT_VOICE_SHORTCUT, true)).toBe("⇧⌘Space");
	});

	it("matches Ctrl+Shift+Space elsewhere and Cmd+Shift+Space on macOS, nothing else", () => {
		const space = { key: " ", code: "Space", shiftKey: true };
		expect(matchesShortcut(key({ ...space, ctrlKey: true }), DEFAULT_VOICE_SHORTCUT, false)).toBe(true);
		expect(matchesShortcut(key({ ...space, metaKey: true }), DEFAULT_VOICE_SHORTCUT, true)).toBe(true);
		expect(matchesShortcut(key({ ...space, metaKey: true }), DEFAULT_VOICE_SHORTCUT, false)).toBe(false);
		expect(matchesShortcut(key({ ...space, ctrlKey: true, altKey: true }), DEFAULT_VOICE_SHORTCUT, false)).toBe(false);
		expect(matchesShortcut(key({ key: " ", code: "Space", ctrlKey: true }), DEFAULT_VOICE_SHORTCUT, false)).toBe(false);
	});
});

describe("parseAccelerator", () => {
	it("refuses typing (no modifier) and unknown parts", () => {
		expect(parseAccelerator("Shift+A")).toBeNull();
		expect(parseAccelerator("A")).toBeNull();
		expect(parseAccelerator("Hyper+A")).toBeNull();
		expect(parseAccelerator("CommandOrControl+Tab")).toBeNull();
		expect(parseAccelerator(42)).toBeNull();
	});
});

describe("shortcutConflict", () => {
	it("names the app shortcut a choice would shadow", () => {
		expect(shortcutConflict("CommandOrControl+K")).toBe("Ctrl+K");
		expect(shortcutConflict("CommandOrControl+Shift+T")).toBe("Ctrl+Shift+T");
		expect(shortcutConflict("CommandOrControl+3")).toBe("Ctrl+1…9");
		expect(shortcutConflict("CommandOrControl+Shift+C")).toBe("Ctrl+Shift+C");
	});

	it("refuses Ctrl+Alt, which is AltGr on AZERTY and QWERTZ", () => {
		expect(shortcutConflict("CommandOrControl+Alt+V")).toBe("altgr");
	});

	it("accepts a free combination", () => {
		expect(shortcutConflict("Alt+Shift+V")).toBeNull();
		expect(shortcutConflict("CommandOrControl+Shift+M")).toBeNull();
	});
});

describe("acceleratorFromEvent", () => {
	it("records what was pressed, layout letter first", () => {
		expect(acceleratorFromEvent(key({ key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }), false)).toBe(
			"CommandOrControl+Shift+M",
		);
		// AZERTY: the key labelled A sits where QWERTY has Q.
		expect(acceleratorFromEvent(key({ key: "a", code: "KeyQ", altKey: true }), false)).toBe("Alt+A");
		// macOS Option turns V into √: the physical key names it.
		expect(acceleratorFromEvent(key({ key: "√", code: "KeyV", altKey: true, metaKey: true }), true)).toBe(
			"CommandOrControl+Alt+V",
		);
	});

	it("ignores a modifier alone and a bare key", () => {
		expect(acceleratorFromEvent(key({ key: "Shift", code: "ShiftLeft", shiftKey: true }), false)).toBeNull();
		expect(acceleratorFromEvent(key({ key: "v", code: "KeyV" }), false)).toBeNull();
	});

	it("round-trips with matchesShortcut", () => {
		const press = key({ key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true });
		const accelerator = acceleratorFromEvent(press, false) ?? "";
		expect(matchesShortcut(press, accelerator, false)).toBe(true);
	});
});
