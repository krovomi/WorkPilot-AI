/**
 * The life of a terminal's xterm: created once in its container with the font
 * settings, sized once the container has a size (and again when it changes),
 * fed what the main process writes, telling the latest callbacks about typed
 * commands and resizes, following font changes, and saving its screen when it
 * is disposed so the next mount shows it again.
 */
import { act, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalBufferManager } from "../../../lib/terminal-buffer-manager";
import { useTerminalFontSettingsStore } from "../../../stores/terminal-font-settings-store";
import { writeToTerminal } from "../../../stores/terminal-store";
import { type UseXtermReturn, useXterm } from "../useXterm";

interface FakeXterm {
	options: Record<string, unknown>;
	cols: number;
	rows: number;
	open: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	writeln: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	refresh: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	type: (data: string) => void;
	resize: (cols: number, rows: number) => void;
}

const fake = vi.hoisted(() => ({
	xterms: [] as unknown[],
	fit: vi.fn(),
	fitDispose: vi.fn(),
	serialize: vi.fn((): string => ""),
	serializeDispose: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		private dataListener?: (data: string) => void;
		private resizeListener?: (size: { cols: number; rows: number }) => void;
		open = vi.fn();
		write = vi.fn();
		writeln = vi.fn();
		focus = vi.fn();
		refresh = vi.fn();
		dispose = vi.fn();
		input = vi.fn();
		loadAddon = vi.fn();
		attachCustomKeyEventHandler = vi.fn();
		parser = { registerOscHandler: vi.fn() };
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
			fake.xterms.push(this);
		}
		onData(listener: (data: string) => void) {
			this.dataListener = listener;
		}
		onResize(listener: (size: { cols: number; rows: number }) => void) {
			this.resizeListener = listener;
		}
		type(data: string) {
			this.dataListener?.(data);
		}
		resize(cols: number, rows: number) {
			this.resizeListener?.({ cols, rows });
		}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit = fake.fit;
		dispose = fake.fitDispose;
	},
}));
vi.mock("@xterm/addon-serialize", () => ({
	SerializeAddon: class {
		serialize = fake.serialize;
		dispose = fake.serializeDispose;
	},
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

const initialFonts = useTerminalFontSettingsStore.getState();
const sendTerminalInput = vi.fn();
let containerSize = { width: 640, height: 384 };
let observers: Array<() => void> = [];
const disconnect = vi.fn();

let hook: UseXtermReturn;
let setCallbacks: (callbacks: Callbacks) => void;

interface Callbacks {
	onCommandEnter?: (command: string) => void;
	onResize?: (cols: number, rows: number) => void;
	onDimensionsReady?: (cols: number, rows: number) => void;
}

function Host({ initial }: { initial: Callbacks }) {
	const [callbacks, set] = useState(initial);
	setCallbacks = set;
	hook = useXterm({ terminalId: "term-1", ...callbacks });
	return <div data-testid="screen" ref={hook.terminalRef} />;
}

function mount(callbacks: Callbacks = {}) {
	const view = render(<Host initial={callbacks} />);
	return { ...view, xterm: fake.xterms.at(-1) as FakeXterm };
}

/** One animation frame and the timers behind it. */
async function frame(ms = 16) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	fake.xterms.length = 0;
	fake.serialize.mockReturnValue("");
	containerSize = { width: 640, height: 384 };
	observers = [];
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				observers.push(callback);
			}
			observe() {
				return undefined;
			}
			disconnect = disconnect;
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => ({ ...containerSize, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
	);
	Object.assign(globalThis.electronAPI, { sendTerminalInput });
	terminalBufferManager.clear("term-1");
});

afterEach(() => {
	useTerminalFontSettingsStore.setState(initialFonts, true);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("useXterm, creation and size", () => {
	it("opens one xterm in its container with the font settings", async () => {
		const { xterm, rerender } = mount();
		const fonts = useTerminalFontSettingsStore.getState();
		expect(fake.xterms).toHaveLength(1);
		expect(xterm.open).toHaveBeenCalledWith(document.querySelector("[data-testid=screen]"));
		expect(xterm.options).toMatchObject({
			fontSize: fonts.fontSize,
			fontFamily: fonts.fontFamily.join(", "),
			scrollback: fonts.scrollback,
			cursorBlink: fonts.cursorBlink,
		});
		expect((xterm.options.theme as { cursorAccent: string }).cursorAccent).toBe(fonts.cursorAccentColor);

		rerender(<Host initial={{}} />);
		act(() => setCallbacks({ onResize: vi.fn() }));
		expect(fake.xterms).toHaveLength(1);
	});

	it("waits for the container to have a size, then reports it once", async () => {
		containerSize = { width: 0, height: 0 };
		const onDimensionsReady = vi.fn();
		const { xterm } = mount({ onDimensionsReady });
		await frame();
		expect(fake.fit).not.toHaveBeenCalled();

		containerSize = { width: 640, height: 384 };
		xterm.cols = 100;
		xterm.rows = 30;
		await frame(50 + 16);
		expect(fake.fit).toHaveBeenCalledOnce();
		expect(onDimensionsReady).toHaveBeenCalledWith(100, 30);
		expect(hook.cols).toBe(100);
		expect(hook.rows).toBe(30);

		observers[0]();
		await frame(200);
		expect(onDimensionsReady).toHaveBeenCalledOnce();
	});

	it("does not report a container measured at zero columns", async () => {
		const onDimensionsReady = vi.fn();
		const { xterm } = mount({ onDimensionsReady });
		xterm.cols = 0;
		await frame();
		expect(fake.fit).toHaveBeenCalledOnce();
		expect(onDimensionsReady).not.toHaveBeenCalled();

		xterm.cols = 90;
		observers[0]();
		await frame(200);
		expect(onDimensionsReady).toHaveBeenCalledWith(90, 24);
	});

	it("fits again when the container is resized, once the resizing settles", async () => {
		const { xterm } = mount();
		await frame();
		fake.fit.mockClear();
		observers[0]();
		await frame(100);
		observers[0]();
		xterm.cols = 120;
		await frame(199);
		expect(fake.fit).not.toHaveBeenCalled();
		await frame(1);
		expect(fake.fit).toHaveBeenCalledOnce();
		expect(hook.cols).toBe(120);

		containerSize = { width: 0, height: 0 };
		observers[0]();
		await frame(200);
		expect(fake.fit).toHaveBeenCalledOnce();
	});

	it("fits when every terminal is asked to, and on demand", async () => {
		const { xterm } = mount();
		await frame();
		fake.fit.mockClear();
		xterm.rows = 40;
		act(() => {
			window.dispatchEvent(new Event("terminal-refit-all"));
		});
		expect(fake.fit).toHaveBeenCalledOnce();
		expect(hook.rows).toBe(40);

		let fitted = false;
		act(() => {
			fitted = hook.fit();
		});
		expect(fitted).toBe(true);
		containerSize = { width: 10, height: 0 };
		act(() => {
			window.dispatchEvent(new Event("terminal-refit-all"));
			fitted = hook.fit();
		});
		expect(fitted).toBe(false);
		expect(fake.fit).toHaveBeenCalledTimes(2);
	});

	it("uses a timer when the page has no animation frames", async () => {
		vi.stubGlobal("requestAnimationFrame", undefined);
		const onDimensionsReady = vi.fn();
		mount({ onDimensionsReady });
		await frame(0);
		expect(onDimensionsReady).toHaveBeenCalledWith(80, 24);
	});

	it("stops observing the container when it goes away", async () => {
		const view = mount();
		await frame();
		fake.fit.mockClear();
		observers[0]();
		view.unmount();
		await frame(200);
		expect(disconnect).toHaveBeenCalled();
		expect(fake.fit).not.toHaveBeenCalled();
	});
});

describe("useXterm, input and output", () => {
	it("sends every keystroke and gives the latest callback the command typed", () => {
		const first = vi.fn();
		const latest = vi.fn();
		const { xterm } = mount({ onCommandEnter: first });
		act(() => setCallbacks({ onCommandEnter: latest }));
		for (const key of ["g", "i", "t", "x", "\x7f", " ", "s", "\t", "\r"]) xterm.type(key);
		expect(sendTerminalInput).toHaveBeenCalledWith("term-1", "g");
		expect(sendTerminalInput).toHaveBeenCalledWith("term-1", "\t");
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledWith("git s");

		for (const key of ["l", "s", "\x03", "p", "w", "d", "\b", "d", "\n"]) xterm.type(key);
		expect(latest).toHaveBeenLastCalledWith("pwd");

		act(() => setCallbacks({}));
		xterm.type("\r");
		expect(latest).toHaveBeenCalledTimes(2);
	});

	it("passes a resize of the xterm to the latest callback", () => {
		const onResize = vi.fn();
		const { xterm } = mount();
		xterm.resize(100, 30);
		act(() => setCallbacks({ onResize }));
		xterm.resize(120, 40);
		expect(onResize).toHaveBeenCalledOnce();
		expect(onResize).toHaveBeenCalledWith(120, 40);
	});

	it("writes, writes lines and focuses through the open xterm only", () => {
		const { xterm } = mount();
		hook.writeln("done");
		hook.focus();
		writeToTerminal("term-1", "live output");
		expect(xterm.writeln).toHaveBeenCalledWith("done");
		expect(xterm.focus).toHaveBeenCalledOnce();
		expect(xterm.write).toHaveBeenCalledWith("live output");

		act(() => hook.dispose());
		hook.writeln("late");
		hook.focus();
		writeToTerminal("term-1", "after dispose");
		expect(xterm.writeln).toHaveBeenCalledOnce();
		expect(xterm.write).not.toHaveBeenCalledWith("after dispose");
	});

	it("stops receiving output once unmounted", () => {
		const view = mount();
		view.unmount();
		writeToTerminal("term-1", "buffered");
		expect(view.xterm.write).not.toHaveBeenCalled();
		expect(terminalBufferManager.get("term-1")).toBe("buffered");
	});
});

describe("useXterm, fonts", () => {
	it("applies a font change to the open terminal, and not after dispose", () => {
		const { xterm } = mount();
		act(() => {
			useTerminalFontSettingsStore.getState().setFontSize(18);
			useTerminalFontSettingsStore.getState().setCursorAccentColor("#ff00ff");
		});
		expect(xterm.options.fontSize).toBe(18);
		expect((xterm.options.theme as { cursorAccent: string }).cursorAccent).toBe("#ff00ff");
		expect(xterm.refresh).toHaveBeenCalledWith(0, 23);
		expect(fake.xterms).toHaveLength(1);

		act(() => hook.dispose());
		xterm.refresh.mockClear();
		act(() => useTerminalFontSettingsStore.getState().setFontSize(20));
		expect(xterm.options.fontSize).toBe(18);
		expect(xterm.refresh).not.toHaveBeenCalled();
	});
});

describe("useXterm, saved screen", () => {
	it("shows the screen saved by the previous mount, and saves its own when disposed", () => {
		terminalBufferManager.set("term-1", "\x1b[32m$\x1b[0m previous");
		const { xterm } = mount();
		expect(xterm.write).toHaveBeenCalledWith("\x1b[32m$\x1b[0m previous");
		expect(terminalBufferManager.get("term-1")).toBe("");

		fake.serialize.mockReturnValue("\x1b[32m$\x1b[0m now");
		act(() => {
			hook.dispose();
			hook.dispose();
		});
		expect(terminalBufferManager.get("term-1")).toBe("\x1b[32m$\x1b[0m now");
		expect(fake.fitDispose).toHaveBeenCalledOnce();
		expect(fake.serializeDispose).toHaveBeenCalledOnce();
		expect(xterm.dispose).toHaveBeenCalledOnce();
		expect(hook.xtermRef.current).toBeNull();
	});

	it("keeps nothing for an empty screen, and survives a screen it cannot save", () => {
		mount();
		act(() => hook.dispose());
		expect(terminalBufferManager.has("term-1")).toBe(false);

		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		mount();
		fake.serialize.mockImplementation(() => {
			throw new Error("disposed renderer");
		});
		expect(() => act(() => hook.dispose())).not.toThrow();
		expect(terminalBufferManager.has("term-1")).toBe(false);
		error.mockRestore();
	});
});

describe("useXterm, without a container or after dispose", () => {
	function Bare() {
		hook = useXterm({ terminalId: "term-1" });
		return null;
	}

	it("creates nothing until it is given a container, and disposes nothing", () => {
		render(<Bare />);
		expect(fake.xterms).toHaveLength(0);
		expect(observers).toHaveLength(0);
		writeToTerminal("term-1", "early output");
		let fitted = true;
		act(() => {
			fitted = hook.fit();
			hook.dispose();
		});
		expect(fitted).toBe(false);
		expect(fake.fitDispose).not.toHaveBeenCalled();
		expect(terminalBufferManager.get("term-1")).toBe("early output");
	});

	it("keeps one xterm for the life of the component", () => {
		const { rerender } = mount();
		rerender(<Host initial={{}} />);
		expect(fake.xterms).toHaveLength(1);
	});

	it("fits nothing once disposed", async () => {
		const { xterm } = mount();
		act(() => hook.dispose());
		await frame();
		observers[0]();
		await frame(200);
		act(() => {
			window.dispatchEvent(new Event("terminal-refit-all"));
		});
		expect(fake.fit).not.toHaveBeenCalled();
		expect(hook.fit()).toBe(false);
		expect(xterm.dispose).toHaveBeenCalledOnce();
	});

	it("leaves tab navigation and the new and close shortcuts to the app", () => {
		const { xterm } = mount();
		const handler = (xterm as unknown as { attachCustomKeyEventHandler: ReturnType<typeof vi.fn> })
			.attachCustomKeyEventHandler.mock.calls[0][0] as (event: Partial<KeyboardEvent>) => boolean;
		for (const key of ["Tab", "t", "T", "w", "W", "3"]) {
			expect(handler({ type: "keydown", key, ctrlKey: true })).toBe(false);
		}
		expect(handler({ type: "keydown", key: "Tab" })).toBe(true);
	});
});
