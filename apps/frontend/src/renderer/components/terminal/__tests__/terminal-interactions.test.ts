/**
 * @vitest-environment jsdom
 */

import type { Terminal as XTerm } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	attachOsc52Clipboard,
	handleClipboardKeyEvent,
	openTerminalUri,
	readTerminalText,
} from "../terminal-interactions";

vi.mock("@xterm/addon-web-links", () => ({
	WebLinksAddon: class {
		constructor(public handler?: unknown) {}
	},
}));

interface FakeTerminal {
	hasSelection: ReturnType<typeof vi.fn>;
	getSelection: ReturnType<typeof vi.fn>;
	paste: ReturnType<typeof vi.fn>;
	parser: { registerOscHandler: ReturnType<typeof vi.fn> };
}

function fakeTerminal(selection = ""): FakeTerminal {
	return {
		hasSelection: vi.fn(() => selection.length > 0),
		getSelection: vi.fn(() => selection),
		paste: vi.fn(),
		parser: { registerOscHandler: vi.fn() },
	};
}

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
	return { type: "keydown", ...init } as KeyboardEvent;
}

const LINUX = { isWindows: false, isLinux: true };
const MAC = { isWindows: false, isLinux: false };

describe("handleClipboardKeyEvent", () => {
	beforeEach(() => {
		Object.assign(navigator, {
			clipboard: {
				writeText: vi.fn(() => Promise.resolve()),
				readText: vi.fn(() => Promise.resolve("pasted")),
			},
		});
	});

	it("copie la sélection sur Cmd/Ctrl+C et consomme la touche", () => {
		const xterm = fakeTerminal("some selection");
		const verdict = handleClipboardKeyEvent(
			xterm as unknown as XTerm,
			keyEvent({ key: "c", ctrlKey: true }),
			LINUX,
		);
		expect(verdict).toBe(false);
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			"some selection",
		);
	});

	it("laisse passer Ctrl+C quand rien n'est sélectionné (interruption)", () => {
		const xterm = fakeTerminal("");
		const verdict = handleClipboardKeyEvent(
			xterm as unknown as XTerm,
			keyEvent({ key: "c", ctrlKey: true }),
			LINUX,
		);
		expect(verdict).toBe(true);
		expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
	});

	it("consomme Ctrl+Shift+C sur Linux même sans sélection", () => {
		const xterm = fakeTerminal("");
		const verdict = handleClipboardKeyEvent(
			xterm as unknown as XTerm,
			keyEvent({ key: "C", ctrlKey: true, shiftKey: true }),
			LINUX,
		);
		expect(verdict).toBe(false);
	});

	it("colle sur Ctrl+V là où c'est le geste attendu", () => {
		const xterm = fakeTerminal("");
		const preventDefault = vi.fn();
		const verdict = handleClipboardKeyEvent(
			xterm as unknown as XTerm,
			keyEvent({ key: "v", ctrlKey: true, preventDefault }),
			LINUX,
		);
		expect(verdict).toBe(false);
		expect(preventDefault).toHaveBeenCalled();
	});

	it("ne se prononce pas sur une touche ordinaire", () => {
		const xterm = fakeTerminal("");
		expect(
			handleClipboardKeyEvent(
				xterm as unknown as XTerm,
				keyEvent({ key: "a" }),
				MAC,
			),
		).toBeUndefined();
	});
});

describe("attachOsc52Clipboard", () => {
	beforeEach(() => {
		Object.assign(navigator, {
			clipboard: { writeText: vi.fn(() => Promise.resolve()) },
		});
	});

	it("écrit dans le presse-papiers ce qu'un programme lui donne", () => {
		const xterm = fakeTerminal();
		attachOsc52Clipboard(xterm as unknown as XTerm);
		const handler = xterm.parser.registerOscHandler.mock.calls[0][1];
		expect(xterm.parser.registerOscHandler.mock.calls[0][0]).toBe(52);

		expect(handler(`c;${btoa("https://example.com/login")}`)).toBe(true);
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
			"https://example.com/login",
		);
	});

	it("n'honore pas une demande de lecture du presse-papiers", () => {
		const xterm = fakeTerminal();
		attachOsc52Clipboard(xterm as unknown as XTerm);
		const handler = xterm.parser.registerOscHandler.mock.calls[0][1];
		expect(handler("c;?")).toBe(false);
		expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
	});
});

describe("openTerminalUri", () => {
	it("ouvre par openExternal, jamais par window.open", () => {
		const openExternal = vi.fn(() => Promise.resolve());
		Object.assign(window, { electronAPI: { openExternal } });
		const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

		openTerminalUri("https://example.com/login", "test");

		expect(openExternal).toHaveBeenCalledWith("https://example.com/login");
		expect(windowOpen).not.toHaveBeenCalled();
	});
});

describe("readTerminalText", () => {
	it("recolle les lignes que xterm a repliées", () => {
		const lines = [
			{ translateToString: () => "https://example.com/oauth?a=1", isWrapped: false },
			{ translateToString: () => "&b=2", isWrapped: true },
			{ translateToString: () => "done", isWrapped: false },
		];
		const xterm = {
			buffer: {
				active: { length: lines.length, getLine: (i: number) => lines[i] },
			},
		};

		expect(readTerminalText(xterm as unknown as XTerm)).toBe(
			"https://example.com/oauth?a=1&b=2\ndone",
		);
	});
});
