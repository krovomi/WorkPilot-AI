import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIOSK_REFRESH_MS, useKioskMode } from "../use-kiosk-mode";

function setFullscreenElement(el: Element | null) {
	Object.defineProperty(document, "fullscreenElement", { configurable: true, value: el });
}

describe("useKioskMode", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		setFullscreenElement(null);
	});

	afterEach(() => {
		vi.useRealTimers();
		Reflect.deleteProperty(document, "fullscreenElement");
		Reflect.deleteProperty(document, "exitFullscreen");
	});

	it("enters full screen on the office, refreshes every minute, and leaves with it", async () => {
		const el = document.createElement("div");
		const requestFullscreen = vi.fn().mockResolvedValue(undefined);
		el.requestFullscreen = requestFullscreen;
		const exitFullscreen = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
		const onRefresh = vi.fn();
		const { result } = renderHook(() => useKioskMode({ current: el }, onRefresh));

		expect(result.current.active).toBe(false);
		act(() => result.current.enter());
		expect(result.current.active).toBe(true);
		expect(requestFullscreen).toHaveBeenCalled();

		act(() => vi.advanceTimersByTime(KIOSK_REFRESH_MS));
		expect(onRefresh).toHaveBeenCalledTimes(1);

		setFullscreenElement(el);
		act(() => document.dispatchEvent(new Event("fullscreenchange")));
		expect(result.current.active).toBe(true);
		// A real full screen handles its own Esc.
		act(() => globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(result.current.active).toBe(true);

		act(() => result.current.exit());
		expect(result.current.active).toBe(false);
		expect(exitFullscreen).toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(KIOSK_REFRESH_MS));
		expect(onRefresh).toHaveBeenCalledTimes(1);
	});

	it("leaves TV mode when the system leaves full screen", () => {
		const el = document.createElement("div");
		el.requestFullscreen = vi.fn().mockResolvedValue(undefined);
		const { result } = renderHook(() => useKioskMode({ current: el }, vi.fn()));
		act(() => result.current.enter());
		act(() => document.dispatchEvent(new Event("fullscreenchange")));
		expect(result.current.active).toBe(false);
	});

	it("stays in the window when full screen is refused or missing, and Esc leaves", async () => {
		const el = document.createElement("div");
		el.requestFullscreen = vi.fn().mockRejectedValue(new Error("no gesture"));
		const { result, rerender } = renderHook(({ target }) => useKioskMode(target, vi.fn()), {
			initialProps: { target: { current: el as HTMLElement | null } },
		});
		await act(async () => result.current.enter());
		expect(result.current.active).toBe(true);
		act(() => globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
		expect(result.current.active).toBe(true);
		act(() => globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(result.current.active).toBe(false);

		rerender({ target: { current: null } });
		act(() => result.current.enter());
		expect(result.current.active).toBe(true);
		// Not in full screen: leaving asks the document nothing.
		act(() => result.current.exit());
		expect(result.current.active).toBe(false);
	});

	it("survives a document that refuses to leave full screen or has no API for it", async () => {
		const el = document.createElement("div");
		const { result } = renderHook(() => useKioskMode({ current: el }, vi.fn()));
		setFullscreenElement(el);
		Object.defineProperty(document, "exitFullscreen", {
			configurable: true,
			value: vi.fn().mockRejectedValue(new Error("gone")),
		});
		await act(async () => result.current.exit());
		expect(result.current.active).toBe(false);

		Object.defineProperty(document, "exitFullscreen", { configurable: true, value: undefined });
		act(() => result.current.exit());
		expect(result.current.active).toBe(false);
	});
});
