/**
 * The stand-in for `window.electronAPI` used by renderer tests answers any
 * method, keeps the overrides a test gives, and puts back what was there.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererApi, type RendererApi } from "./renderer-api";

const scope = globalThis as unknown as { electronAPI?: Record<string, unknown> };

let installed: RendererApi | undefined;

afterEach(() => {
	installed?.restore();
	installed = undefined;
});

describe("installRendererApi", () => {
	it("answers any method: listeners unsubscribe, calls resolve success", async () => {
		installed = installRendererApi();
		const api = scope.electronAPI as Record<string, (...a: unknown[]) => unknown>;
		const unsubscribe = api.onTaskProgress(() => undefined);
		expect(typeof unsubscribe).toBe("function");
		expect((api.subscribeLogs as () => () => void)()()).toBeUndefined();
		await expect(api.getTasks("p1")).resolves.toEqual({ success: true });
		expect(installed.fn("getTasks")).toHaveBeenCalledWith("p1");
		expect("anything" in api).toBe(true);
	});

	it("answers a namespace's methods the same way", async () => {
		installed = installRendererApi();
		const api = scope.electronAPI as Record<
			string,
			Record<string, (...a: unknown[]) => unknown>
		>;
		expect(typeof api.github.onPRReviewProgress(() => undefined)).toBe(
			"function",
		);
		await expect(api.github.getPRs("p1")).resolves.toEqual({ success: true });
		expect(installed.fn("github.getPRs")).toHaveBeenCalledWith("p1");
		expect(api.github.getPRs).toBe(installed.fn("github.getPRs"));
		// A method keeps its own mock API and is not awaited as a promise.
		expect(vi.isMockFunction(api.github)).toBe(true);
		expect((api.github as unknown as { then?: unknown }).then).toBeUndefined();
	});

	it("keeps a mock override, wraps a plain function, and returns a value as is", async () => {
		const mock = vi.fn().mockResolvedValue({ success: false });
		installed = installRendererApi({
			getProjects: mock,
			getVersion: () => "1.5.0",
			platform: "linux",
		});
		const api = scope.electronAPI as Record<string, unknown>;
		expect(api.getProjects).toBe(mock);
		expect((api.getVersion as () => string)()).toBe("1.5.0");
		expect(installed.fn("getVersion")).toHaveBeenCalledOnce();
		expect(api.platform).toBe("linux");
	});

	it("is not a thenable and ignores symbol keys", async () => {
		installed = installRendererApi();
		const api = scope.electronAPI as Record<string | symbol, unknown>;
		expect(api.then).toBeUndefined();
		expect(api[Symbol.iterator]).toBeUndefined();
		// Awaiting the bridge must not hang on a fake `then`.
		await expect(Promise.resolve(api)).resolves.toBe(api);
	});

	it("restores the bridge that was there before", () => {
		const before = { marker: true };
		scope.electronAPI = before;
		const api = installRendererApi();
		expect(scope.electronAPI).not.toBe(before);
		api.restore();
		expect(scope.electronAPI).toBe(before);
		delete scope.electronAPI;
	});
});
