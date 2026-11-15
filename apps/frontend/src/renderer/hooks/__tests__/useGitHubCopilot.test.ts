/**
 * The GitHub Copilot settings hook: what it reads at mount, what each action
 * asks the service and reloads after, the error it shows when one fails, and
 * the status pushed by the service while the page is open.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => {
	const handlers = new Map<string, (value: unknown) => void>();
	return {
		handlers,
		getStatus: vi.fn(),
		getConfig: vi.fn(),
		setToken: vi.fn(),
		removeToken: vi.fn(),
		authenticate: vi.fn(),
		logout: vi.fn(),
		testConnection: vi.fn(),
		refreshStatus: vi.fn(),
		on: vi.fn((event: string, handler: (value: unknown) => void) => handlers.set(event, handler)),
		off: vi.fn((event: string) => handlers.delete(event)),
	};
});
vi.mock("@shared/services/githubCopilotService", () => ({ gitHubCopilotService: service }));

import { useGitHubCopilot } from "../useGitHubCopilot";

const SIGNED_OUT = { installed: true, authenticated: false };
const SIGNED_IN = { installed: true, authenticated: true, username: "octo" };

beforeEach(() => {
	for (const [key, fn] of Object.entries(service)) {
		if (key !== "handlers" && key !== "on" && key !== "off") (fn as ReturnType<typeof vi.fn>).mockReset();
	}
	service.handlers.clear();
	service.getStatus.mockResolvedValue(SIGNED_OUT);
	service.getConfig.mockResolvedValue({ enabled: false });
});

async function mounted() {
	const hook = renderHook(() => useGitHubCopilot());
	await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
	return hook;
}

describe("loading", () => {
	it("reads the status and the config at mount", async () => {
		const { result } = await mounted();
		expect(result.current).toMatchObject({ status: SIGNED_OUT, config: { enabled: false }, error: null });
	});

	it("shows why the status could not be read", async () => {
		service.getStatus.mockRejectedValueOnce(new Error("gh not found"));
		const { result } = await mounted();
		expect(result.current.error).toBe("gh not found");

		service.getStatus.mockRejectedValueOnce("x");
		const second = await mounted();
		expect(second.result.current.error).toBe("Unknown error");
	});

	it("follows the status and config the service pushes, until unmount", async () => {
		const { result, unmount } = await mounted();
		act(() => service.handlers.get("status-updated")?.(SIGNED_IN));
		act(() => service.handlers.get("config-updated")?.({ enabled: true }));
		expect(result.current).toMatchObject({ status: SIGNED_IN, config: { enabled: true } });
		unmount();
		expect(service.off).toHaveBeenCalledWith("status-updated", expect.any(Function));
		expect(service.off).toHaveBeenCalledWith("config-updated", expect.any(Function));
	});
});

describe("actions", () => {
	const actions = [
		["setToken", (h: ReturnType<typeof useGitHubCopilot>) => h.setToken("ghp_test0000"), "setToken", ["ghp_test0000"], "Failed to set token"],
		["removeToken", (h: ReturnType<typeof useGitHubCopilot>) => h.removeToken(), "removeToken", [], "Failed to remove token"],
		["authenticate", (h: ReturnType<typeof useGitHubCopilot>) => h.authenticate(), "authenticate", [], "Failed to authenticate"],
		["logout", (h: ReturnType<typeof useGitHubCopilot>) => h.logout(), "logout", [], "Failed to logout"],
	] as const;

	it.each(actions)("%s calls the service, then reloads the status and config", async (_n, run, method, args) => {
		const { result } = await mounted();
		service.getStatus.mockResolvedValue(SIGNED_IN);
		service.getConfig.mockResolvedValue({ enabled: true });
		await act(() => run(result.current));
		expect(service[method]).toHaveBeenCalledWith(...args);
		expect(result.current).toMatchObject({ status: SIGNED_IN, config: { enabled: true }, error: null });
	});

	it.each(actions)("%s shows and rethrows a failure", async (_n, run, method, _args, fallback) => {
		const { result } = await mounted();
		service[method].mockRejectedValueOnce(new Error("denied"));
		await act(() => expect(run(result.current)).rejects.toThrow("denied"));
		expect(result.current.error).toBe("denied");

		service[method].mockRejectedValueOnce("x");
		await act(() => expect(run(result.current)).rejects.toBe("x"));
		expect(result.current.error).toBe(fallback);
	});

	it("refreshes the CLI's status after authenticating", async () => {
		const { result } = await mounted();
		await act(() => result.current.authenticate());
		expect(service.refreshStatus).toHaveBeenCalled();
	});

	it("tests the connection, turning a failure into an answer", async () => {
		const { result } = await mounted();
		service.testConnection.mockResolvedValueOnce({ success: true, message: "ok" });
		await expect(result.current.testConnection()).resolves.toEqual({ success: true, message: "ok" });

		service.testConnection.mockRejectedValueOnce(new Error("timeout"));
		let answer: unknown;
		await act(async () => {
			answer = await result.current.testConnection();
		});
		expect(answer).toEqual({ success: false, message: "timeout" });
		expect(result.current.error).toBe("timeout");

		service.testConnection.mockRejectedValueOnce(1);
		await act(async () => {
			answer = await result.current.testConnection();
		});
		expect(answer).toEqual({ success: false, message: "Failed to test connection" });
	});

	it("refreshes the status, and shows a failure without throwing", async () => {
		const { result } = await mounted();
		service.getStatus.mockResolvedValue(SIGNED_IN);
		await act(() => result.current.refreshStatus());
		expect(result.current).toMatchObject({ status: SIGNED_IN, isLoading: false });

		service.refreshStatus.mockRejectedValueOnce(new Error("rate limited"));
		await act(() => result.current.refreshStatus());
		expect(result.current).toMatchObject({ error: "rate limited", isLoading: false });

		service.refreshStatus.mockRejectedValueOnce(null);
		await act(() => result.current.refreshStatus());
		expect(result.current.error).toBe("Failed to refresh status");

		act(() => result.current.clearError());
		expect(result.current.error).toBeNull();
	});
});
