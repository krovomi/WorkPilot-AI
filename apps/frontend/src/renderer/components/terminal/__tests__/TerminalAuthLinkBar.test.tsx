/**
 * The sign-in link pulled out of an authentication terminal: found in what the
 * screen shows (not the raw stream), rescanned at most once per delay, and
 * offered with buttons that say when they fail.
 */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { Terminal as XTerm } from "@xterm/xterm";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAuthLinkBar } from "../TerminalAuthLinkBar";
import { useTerminalAuthUrl } from "../use-terminal-auth-url";

const LOGIN = "https://claude.ai/oauth/authorize?code=true&state=abc";

function screenOf(lines: string[]) {
	return {
		cols: 80,
		buffer: {
			active: {
				length: lines.length,
				getLine: (i: number) => ({ translateToString: () => lines[i], isWrapped: false }),
			},
		},
	} as unknown as XTerm;
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("useTerminalAuthUrl", () => {
	it("finds the sign-in link once the screen has settled, and keeps it", () => {
		vi.useFakeTimers();
		const ref = { current: screenOf(["Open this link:", LOGIN]) };
		const { result } = renderHook(() => useTerminalAuthUrl(ref, 100));
		act(() => {
			result.current.scanForAuthUrl();
			result.current.scanForAuthUrl();
		});
		expect(result.current.authUrl).toBeNull();
		act(() => vi.advanceTimersByTime(100));
		expect(result.current.authUrl).toBe(LOGIN);

		const before = result.current;
		ref.current = screenOf(["Waiting for the browser…"]);
		act(() => {
			result.current.scanForAuthUrl();
			vi.advanceTimersByTime(100);
		});
		expect(result.current.authUrl).toBe(LOGIN);

		ref.current = screenOf([LOGIN]);
		act(() => {
			result.current.scanForAuthUrl();
			vi.advanceTimersByTime(100);
		});
		expect(result.current).toBe(before);
	});

	it("does nothing without a terminal, and survives a screen it cannot read", () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const ref = { current: null as XTerm | null };
		const { result } = renderHook(() => useTerminalAuthUrl(ref));
		act(() => {
			result.current.scanForAuthUrl();
			vi.advanceTimersByTime(400);
		});
		expect(result.current.authUrl).toBeNull();

		ref.current = {
			cols: 80,
			buffer: {
				active: {
					length: 1,
					getLine: () => {
						throw new Error("disposed");
					},
				},
			},
		} as unknown as XTerm;
		act(() => {
			result.current.scanForAuthUrl();
			vi.advanceTimersByTime(400);
		});
		expect(warn).toHaveBeenCalled();
		expect(result.current.authUrl).toBeNull();
	});

	it("drops a pending scan when the terminal goes away", () => {
		vi.useFakeTimers();
		const getLine = vi.fn();
		const ref = { current: { cols: 80, buffer: { active: { length: 1, getLine } } } as unknown as XTerm };
		const { result, unmount } = renderHook(() => useTerminalAuthUrl(ref));
		act(() => result.current.scanForAuthUrl());
		unmount();
		vi.advanceTimersByTime(1000);
		expect(getLine).not.toHaveBeenCalled();
	});
});

describe("TerminalAuthLinkBar", () => {
	it("copies the link and says so for two seconds", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn(() => Promise.resolve());
		Object.assign(navigator, { clipboard: { writeText } });
		render(<TerminalAuthLinkBar url={LOGIN} />);
		expect(screen.getByTitle(LOGIN).textContent).toBe(LOGIN);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
		});
		expect(writeText).toHaveBeenCalledWith(LOGIN);
		expect(screen.getByRole("button", { name: "Copied!" })).toBeTruthy();
		act(() => vi.advanceTimersByTime(2000));
		expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
	});

	it("says when the link could not be copied", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		Object.assign(navigator, { clipboard: undefined });
		Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
		render(<TerminalAuthLinkBar url={LOGIN} />);
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
		});
		expect(screen.getByText("Could not copy the link to the clipboard.")).toBeTruthy();
	});

	it("opens the link in the browser, and says why when it cannot", async () => {
		const openExternal = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("No browser found"))
			.mockRejectedValueOnce("denied");
		Object.assign(window, { electronAPI: { openExternal } });
		render(<TerminalAuthLinkBar url={LOGIN} />);
		const open = screen.getByRole("button", { name: "Open in browser" });
		await act(async () => {
			fireEvent.click(open);
		});
		expect(openExternal).toHaveBeenCalledWith(LOGIN);
		await act(async () => {
			fireEvent.click(open);
		});
		expect(screen.getByText("No browser found")).toBeTruthy();
		await act(async () => {
			fireEvent.click(open);
		});
		expect(screen.getByText("denied")).toBeTruthy();
	});
});
