/**
 * @vitest-environment jsdom
 */

import type { Terminal as XTerm } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	attachOsc52Clipboard,
	attachTerminalInteractions,
	copySelection,
	copyTextToClipboard,
	createTerminalWebLinksAddon,
	detectClipboardPlatform,
	handleClipboardKeyEvent,
	openTerminalUri,
	pasteIntoTerminal,
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

describe("pasteIntoTerminal", () => {
	const paste = async (read: (() => Promise<string>) | undefined) => {
		Object.assign(navigator, { clipboard: read ? { readText: read } : undefined });
		const xterm = fakeTerminal("");
		pasteIntoTerminal(xterm as unknown as XTerm);
		await new Promise((resolve) => setTimeout(resolve, 0));
		return xterm;
	};

	it("colle le texte du presse-papiers, et rien quand il est vide", async () => {
		expect((await paste(() => Promise.resolve("ls -la"))).paste).toHaveBeenCalledWith("ls -la");
		expect((await paste(() => Promise.resolve(""))).paste).not.toHaveBeenCalled();
	});

	it("journalise un presse-papiers illisible, et ignore son absence", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect((await paste(() => Promise.reject(new Error("denied")))).paste).not.toHaveBeenCalled();
		expect(error).toHaveBeenCalledWith("[terminal] Failed to read clipboard:", expect.any(Error));
		expect((await paste(undefined)).paste).not.toHaveBeenCalled();
		error.mockRestore();
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

describe("copyTextToClipboard", () => {
	let execCommand: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		execCommand = vi.fn(() => true);
		Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("ne copie rien de vide", async () => {
		expect(await copyTextToClipboard("")).toBe(false);
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("passe par l'API du presse-papiers quand elle répond", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.assign(navigator, { clipboard: { writeText } });
		expect(await copyTextToClipboard("code")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("code");
		expect(execCommand).not.toHaveBeenCalled();
	});

	it("se replie sur execCommand quand l'API refuse, sans laisser de zone de texte", async () => {
		Object.assign(navigator, {
			clipboard: { writeText: vi.fn(() => Promise.reject(new Error("no focus"))) },
		});
		expect(await copyTextToClipboard("code")).toBe(true);
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(document.querySelector("textarea")).toBeNull();

		execCommand.mockReturnValue(false);
		expect(await copyTextToClipboard("code")).toBe(false);
	});

	it("ne prétend pas avoir copié quand l'API est absente : il se replie", async () => {
		Object.assign(navigator, { clipboard: undefined });
		execCommand.mockReturnValue(false);
		expect(await copyTextToClipboard("code")).toBe(false);
		execCommand.mockReturnValue(true);
		expect(await copyTextToClipboard("code")).toBe(true);
	});

	it("rend false quand le repli échoue aussi", async () => {
		Object.assign(navigator, { clipboard: undefined });
		execCommand.mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(await copyTextToClipboard("code")).toBe(false);
	});
});

describe("copySelection", () => {
	it("laisse passer la touche quand la sélection est vide", () => {
		const xterm = { hasSelection: () => true, getSelection: () => "" };
		expect(copySelection(xterm as unknown as XTerm)).toBe(false);
	});

	it("journalise une copie qui échoue après coup", async () => {
		Object.assign(navigator, { clipboard: undefined });
		Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const xterm = fakeTerminal("selected");
		expect(copySelection(xterm as unknown as XTerm)).toBe(true);
		await vi.waitFor(() => expect(error).toHaveBeenCalled());
		error.mockRestore();
	});
});

describe("liens du terminal", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dit qu'il ne peut pas ouvrir un lien sans openExternal", () => {
		Object.assign(window, { electronAPI: {} });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		openTerminalUri("https://example.com", "auth");
		expect(warn).toHaveBeenCalledWith(
			"[auth] openExternal unavailable, cannot open:",
			"https://example.com",
		);
	});

	it("journalise un lien que le système refuse d'ouvrir", async () => {
		const failure = new Error("no browser");
		Object.assign(window, { electronAPI: { openExternal: () => Promise.reject(failure) } });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		openTerminalUri("https://example.com", "auth");
		await vi.waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				"[auth] Failed to open URL:",
				"https://example.com",
				failure,
			),
		);
	});

	it("ouvre un lien cliqué et empêche le window.open de l'addon", () => {
		const openExternal = vi.fn(() => Promise.resolve());
		Object.assign(window, { electronAPI: { openExternal } });
		const addon = createTerminalWebLinksAddon("auth") as unknown as {
			handler: (event: MouseEvent, uri: string) => boolean;
		};
		expect(addon.handler({} as MouseEvent, "https://example.com/a")).toBe(false);
		expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
	});
});

describe("OSC 52, charges refusées", () => {
	it("ignore une séquence sans cible, vide, illisible ou qui ne décode rien", () => {
		const writeText = vi.fn(() => Promise.resolve());
		Object.assign(navigator, { clipboard: { writeText } });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const xterm = fakeTerminal();
		attachOsc52Clipboard(xterm as unknown as XTerm);
		const handler = xterm.parser.registerOscHandler.mock.calls[0][1];
		expect(handler("no-separator")).toBe(false);
		expect(handler("c;")).toBe(false);
		expect(handler("c;***")).toBe(false);
		expect(warn).toHaveBeenCalled();
		// Base64 ignores blanks: this one decodes to nothing, so nothing is copied.
		expect(handler("c; ")).toBe(true);
		expect(writeText).not.toHaveBeenCalled();
		expect(handler("c;AA==")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("\u0000");
		warn.mockRestore();
	});

	it("ne fait rien sur un terminal sans analyseur", () => {
		expect(() => attachOsc52Clipboard({} as XTerm)).not.toThrow();
	});
});

describe("readTerminalText, tampons incomplets", () => {
	it("rend une chaîne vide sans tampon et saute une ligne absente", () => {
		expect(readTerminalText({} as XTerm)).toBe("");
		const xterm = {
			buffer: {
				active: {
					length: 3,
					getLine: (i: number) =>
						i === 1 ? undefined : { translateToString: () => `l${i}`, isWrapped: i === 0 },
				},
			},
		};
		expect(readTerminalText(xterm as unknown as XTerm, 2)).toBe("l2");
		expect(readTerminalText(xterm as unknown as XTerm)).toBe("l0\nl2");
	});
});

describe("attachTerminalInteractions", () => {
	it("charge les liens, OSC 52 et les raccourcis du presse-papiers", () => {
		const xterm = {
			...fakeTerminal("sel"),
			loadAddon: vi.fn(),
			attachCustomKeyEventHandler: vi.fn(),
		};
		Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
		const addon = attachTerminalInteractions(xterm as unknown as XTerm, "auth", LINUX);
		expect(xterm.loadAddon).toHaveBeenCalledWith(addon);
		expect(xterm.parser.registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function));
		const onKey = xterm.attachCustomKeyEventHandler.mock.calls[0][0];
		expect(onKey(keyEvent({ key: "a" }))).toBe(true);
		expect(onKey(keyEvent({ key: "c", ctrlKey: true }))).toBe(false);
	});

	it("détecte la plateforme par défaut", () => {
		const platform = detectClipboardPlatform();
		expect(typeof platform.isWindows).toBe("boolean");
		expect(typeof platform.isLinux).toBe("boolean");
		const xterm = { ...fakeTerminal(), loadAddon: vi.fn(), attachCustomKeyEventHandler: vi.fn() };
		attachTerminalInteractions(xterm as unknown as XTerm, "auth");
		expect(xterm.attachCustomKeyEventHandler).toHaveBeenCalledOnce();
	});
});
