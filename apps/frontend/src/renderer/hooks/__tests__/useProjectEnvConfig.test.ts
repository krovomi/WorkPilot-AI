/**
 * @vitest-environment jsdom
 */
/**
 * The promise: a project's configuration is never readable — and therefore
 * never writable — under another project.
 *
 * The bug this pins down was found on disk, not in theory: a local-only test
 * project with no git remote held `GITHUB_REPO=krovomi/WorkPilot-AI`,
 * `GITHUB_AUTO_SYNC=true` and another project's Context7 key. The loading
 * effect is asynchronous and nothing dropped the previous project's
 * configuration, so for a few renders `selectedProjectId` was the new project
 * while `envConfig` was still the old one — and every save sends the whole
 * configuration.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEnvConfig } from "../../../shared/types";
import { useProjectEnvConfig } from "../useProjectEnvConfig";

const CONFIG_A: ProjectEnvConfig = {
	githubEnabled: true,
	githubRepo: "owner/project-a",
} as ProjectEnvConfig;

const CONFIG_B: ProjectEnvConfig = {
	githubEnabled: false,
} as ProjectEnvConfig;

const getProjectEnv = vi.fn();

(globalThis as unknown as { electronAPI: unknown }).electronAPI = {
	getProjectEnv,
};

/** A request whose answer the test decides when to give. */
function deferred<T>() {
	let settle!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return { promise, settle };
}

beforeEach(() => {
	getProjectEnv.mockReset();
});

describe("useProjectEnvConfig", () => {
	it("exposes the configuration of the project it was asked for", async () => {
		getProjectEnv.mockResolvedValue({ success: true, data: CONFIG_A });

		const { result } = renderHook(() => useProjectEnvConfig("a", ".workpilot"));

		await waitFor(() => expect(result.current.envConfig).toEqual(CONFIG_A));
		expect(getProjectEnv).toHaveBeenCalledWith("a");
	});

	it("hides it the moment another project is selected", async () => {
		getProjectEnv.mockResolvedValue({ success: true, data: CONFIG_A });

		const { result, rerender } = renderHook(
			({ id }: { id: string }) => useProjectEnvConfig(id, ".workpilot"),
			{ initialProps: { id: "a" } },
		);
		await waitFor(() => expect(result.current.envConfig).toEqual(CONFIG_A));

		// The load for "b" has not answered yet: this is the window in which a
		// field losing focus used to save A's configuration into B.
		const pending = deferred<{ success: boolean; data: ProjectEnvConfig }>();
		getProjectEnv.mockReturnValue(pending.promise);
		rerender({ id: "b" });

		expect(result.current.envConfig).toBeNull();

		await act(async () => {
			pending.settle({ success: true, data: CONFIG_B });
		});
		expect(result.current.envConfig).toEqual(CONFIG_B);
	});

	it("does not let an update write onto another project's configuration", async () => {
		getProjectEnv.mockResolvedValue({ success: true, data: CONFIG_A });

		const { result, rerender } = renderHook(
			({ id }: { id: string }) => useProjectEnvConfig(id, ".workpilot"),
			{ initialProps: { id: "a" } },
		);
		await waitFor(() => expect(result.current.envConfig).toEqual(CONFIG_A));

		getProjectEnv.mockReturnValue(deferred<unknown>().promise);
		rerender({ id: "b" });

		// What an optimistic update does, while B is still loading.
		act(() => {
			result.current.setEnvConfig((previous) => {
				// The updater is handed B's (absent) configuration, never A's.
				expect(previous).toBeNull();
				return previous ? { ...previous, githubEnabled: false } : null;
			});
		});

		expect(result.current.envConfig).toBeNull();

		// And going back to A has not lost or altered anything of A's.
		getProjectEnv.mockResolvedValue({ success: true, data: CONFIG_A });
		rerender({ id: "a" });
		await waitFor(() => expect(result.current.envConfig).toEqual(CONFIG_A));
	});

	it("drops a response that arrives after the project changed", async () => {
		const first = deferred<{ success: boolean; data: ProjectEnvConfig }>();
		getProjectEnv.mockReturnValue(first.promise);

		const { result, rerender } = renderHook(
			({ id }: { id: string }) => useProjectEnvConfig(id, ".workpilot"),
			{ initialProps: { id: "a" } },
		);

		getProjectEnv.mockResolvedValue({ success: true, data: CONFIG_B });
		rerender({ id: "b" });
		await waitFor(() => expect(result.current.envConfig).toEqual(CONFIG_B));

		await act(async () => {
			first.settle({ success: true, data: CONFIG_A });
		});
		expect(result.current.envConfig).toEqual(CONFIG_B);
	});

	it("asks for nothing when the project is not initialized", () => {
		const { result } = renderHook(() => useProjectEnvConfig("a", null));

		expect(result.current.envConfig).toBeNull();
		expect(getProjectEnv).not.toHaveBeenCalled();
	});
});
