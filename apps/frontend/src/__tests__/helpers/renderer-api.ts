/**
 * A stand-in for `window.electronAPI` in renderer component tests.
 *
 * Big components (the Kanban board, the sidebar, App) reach dozens of IPC
 * methods through their children. Listing every one in each test would hide
 * the few the test is about, so the stand-in answers any method:
 *
 * - `on…` / `subscribe…` listeners return an unsubscribe function;
 * - every other method resolves `{ success: true }` (no data), the answer of
 *   a main process with nothing to report.
 *
 * A test passes the methods it cares about in `overrides` and asserts on the
 * returned `calls`, so the behaviour under test stays explicit.
 *
 *     const api = installRendererApi({ getTasks: vi.fn().mockResolvedValue(…) });
 *     …
 *     expect(api.fn("stopTask")).toHaveBeenCalledWith("t1");
 */

import { type Mock, vi } from "vitest";

export interface RendererApi {
	/** The installed object, on `globalThis.electronAPI` (`window` is `globalThis` under jsdom). */
	api: Record<string, unknown>;
	/** The mock behind a method, created on first access. */
	fn: (name: string) => Mock;
	/** Restore whatever `electronAPI` held before. */
	restore: () => void;
}

const LISTENER = /^(on|subscribe)[A-Z]/;

export function installRendererApi(
	overrides: Record<string, unknown> = {},
): RendererApi {
	const scope = globalThis as unknown as { electronAPI?: unknown };
	const previous = scope.electronAPI;
	const mocks = new Map<string, Mock>();

	const fn = (name: string): Mock => {
		let mock = mocks.get(name);
		if (!mock) {
			const override = overrides[name];
			if (typeof override === "function") {
				mock = vi.isMockFunction(override)
					? (override as Mock)
					: vi.fn(override as (...args: unknown[]) => unknown);
			} else if (LISTENER.test(name)) {
				mock = vi.fn(() => () => undefined);
			} else {
				mock = vi.fn(async () => ({ success: true }));
			}
			mocks.set(name, mock);
		}
		return mock;
	};

	const api = new Proxy({} as Record<string, unknown>, {
		get(_target, prop) {
			if (typeof prop !== "string" || prop === "then") return undefined;
			const override = overrides[prop];
			if (override !== undefined && typeof override !== "function") {
				return override;
			}
			return fn(prop);
		},
		has: () => true,
	});

	scope.electronAPI = api;

	return {
		api,
		fn,
		restore: () => {
			scope.electronAPI = previous;
		},
	};
}
