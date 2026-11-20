/**
 * Two small hooks of the app shell: the stats of a task's pull request (GitHub
 * or Azure DevOps), and the global keyboard shortcuts.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "../useKeyboardShortcuts";
import { usePullRequestStats } from "../usePullRequestStats";

const getPRDetails = vi.fn();
const stats = (files: number) => ({ success: true, data: { data: { changedFiles: files } } });

beforeEach(() => {
	getPRDetails.mockReset().mockResolvedValue(stats(3));
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = { getPRDetails };
});

describe("the stats of a task's pull request", () => {
	it.each([
		["GitHub", "https://github.com/o/r/pull/42", 42],
		["Azure DevOps", "https://dev.azure.com/o/p/_git/r/pullrequest/123456", 123456],
	])("reads them for a %s PR", async (_forge, url, number) => {
		const { result } = renderHook(() => usePullRequestStats(url, "t1"));
		expect(result.current.isLoading).toBe(true);
		await waitFor(() => expect(result.current.prData).toEqual({ changedFiles: 3 }));
		expect(getPRDetails).toHaveBeenCalledWith(number, "t1");
		expect(result.current).toMatchObject({ isLoading: false, error: null });
	});

	it("asks nothing without a URL or a task", () => {
		expect(renderHook(() => usePullRequestStats(null, "t1")).result.current).toEqual({ prData: null, isLoading: false, error: null });
		renderHook(() => usePullRequestStats("https://github.com/o/r/pull/1"));
		expect(getPRDetails).not.toHaveBeenCalled();
	});

	it("says why it has no stats", async () => {
		const read = async (url: string) => {
			const { result } = renderHook(() => usePullRequestStats(url, "t1"));
			await waitFor(() => expect(result.current.isLoading).toBe(false));
			return result.current.error;
		};
		expect(await read("https://example.test/merge/1")).toBe("Could not extract PR number from URL");
		getPRDetails.mockResolvedValueOnce({ success: true, data: { error: "no access" } });
		expect(await read("https://github.com/o/r/pull/1")).toBe("no access");
		getPRDetails.mockResolvedValueOnce({ success: false, error: "no token" });
		expect(await read("https://github.com/o/r/pull/1")).toBe("no token");
		getPRDetails.mockResolvedValueOnce({ success: false });
		expect(await read("https://github.com/o/r/pull/1")).toBe("Failed to fetch PR details");
		const errors = vi.spyOn(console, "error").mockReturnValue(undefined);
		getPRDetails.mockRejectedValueOnce(new Error("ipc closed"));
		expect(await read("https://github.com/o/r/pull/1")).toBe("ipc closed");
		getPRDetails.mockRejectedValueOnce("x");
		expect(await read("https://github.com/o/r/pull/1")).toBe("Unknown error occurred");
		expect(errors).toHaveBeenCalledTimes(2);
	});

	it("shows the stats of the PR now on screen, not a late answer for the last one", async () => {
		let late: (value: unknown) => void = vi.fn();
		getPRDetails.mockReturnValueOnce(new Promise((resolve) => (late = resolve))).mockResolvedValueOnce(stats(7));
		const { result, rerender } = renderHook(({ url }) => usePullRequestStats(url, "t1"), {
			initialProps: { url: "https://github.com/o/r/pull/1" },
		});
		rerender({ url: "https://github.com/o/r/pull/2" });
		await waitFor(() => expect(result.current.prData).toEqual({ changedFiles: 7 }));
		await act(async () => late(stats(1)));
		expect(result.current).toMatchObject({ prData: { changedFiles: 7 }, isLoading: false });
	});

	it("stops loading when the PR goes away mid-request, and drops its late failure", async () => {
		let fail: (reason: unknown) => void = vi.fn();
		getPRDetails.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
		const { result, rerender } = renderHook(({ url }: { url: string | null }) => usePullRequestStats(url, "t1"), {
			initialProps: { url: "https://github.com/o/r/pull/1" } as { url: string | null },
		});
		rerender({ url: null });
		expect(result.current.isLoading).toBe(false);
		await act(async () => fail(new Error("late")));
		expect(result.current.error).toBeNull();
	});
});

describe("keyboard shortcuts", () => {
	const actions = () => ({
		onCommandPalette: vi.fn(),
		onKeyboardShortcuts: vi.fn(),
		onNewTask: vi.fn(),
		onOpenSettings: vi.fn(),
		onNavigate: vi.fn(),
	});
	const press = (key: string, init: KeyboardEventInit = { ctrlKey: true }, target: EventTarget = window) => {
		const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};

	it("runs each shortcut with Ctrl or Cmd, and keeps the key from the page", () => {
		const a = actions();
		renderHook(() => useKeyboardShortcuts(a));
		expect(press("K")).toBe(true);
		press("/", { metaKey: true });
		press("n");
		press(",");
		press("5");
		for (const [key, view] of [["1", "kanban"], ["2", "terminals"], ["3", "insights"], ["4", "roadmap"]]) {
			press(key);
			expect(a.onNavigate).toHaveBeenLastCalledWith(view);
		}
		expect(a.onCommandPalette).toHaveBeenCalledOnce();
		expect(a.onKeyboardShortcuts).toHaveBeenCalledOnce();
		expect(a.onNewTask).toHaveBeenCalledOnce();
		expect(a.onOpenSettings).toHaveBeenCalledTimes(2);
	});

	it("leaves other keys, keys without a modifier, and typing in a field alone", () => {
		const a = actions();
		renderHook(() => useKeyboardShortcuts(a));
		expect(press("x")).toBe(false);
		expect(press("k", {})).toBe(false);
		for (const tag of ["input", "textarea", "select"]) {
			const field = document.body.appendChild(document.createElement(tag));
			press("k", { ctrlKey: true }, field);
		}
		const editable = document.body.appendChild(document.createElement("div"));
		Object.defineProperty(editable, "isContentEditable", { value: true });
		press("k", { ctrlKey: true }, editable);
		expect(Object.values(a).every((fn) => fn.mock.calls.length === 0)).toBe(true);
	});

	it("stops listening when the shell unmounts", () => {
		const a = actions();
		const { unmount } = renderHook(() => useKeyboardShortcuts(a));
		unmount();
		press("k");
		expect(a.onCommandPalette).not.toHaveBeenCalled();
	});
});
