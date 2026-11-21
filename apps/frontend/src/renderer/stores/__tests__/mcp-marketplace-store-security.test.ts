/**
 * The marketplace store and the security of installed servers (#369, lot 2):
 * the project's install policy and the daily check's alerts, as the main
 * reads them, an install the policy refuses, and acknowledging alerts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpMarketplaceServer } from "../../../shared/types/mcp-marketplace";
import {
	acknowledgeServerAlerts,
	installMarketplaceServer,
	loadInstalledWatch,
	loadMcpPolicy,
	useMcpMarketplaceStore,
} from "../mcp-marketplace-store";

const api = {
	getProjectEnv: vi.fn(),
	updateProjectEnv: vi.fn(),
	getMcpInstallPolicy: vi.fn(),
	getMcpInstalledWatch: vi.fn(),
	acknowledgeMcpAlerts: vi.fn(),
};

const INITIAL = useMcpMarketplaceStore.getState();
const store = () => useMcpMarketplaceStore.getState();
const VIEW = { servers: [{ serverId: "git", status: "pending", alerts: [] }] };

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
	useMcpMarketplaceStore.setState(INITIAL, true);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("loadMcpPolicy", () => {
	it("keeps the policy the main read, for its project", async () => {
		api.getMcpInstallPolicy.mockResolvedValue({ success: true, data: { state: "none" } });
		await loadMcpPolicy("p1");
		expect(api.getMcpInstallPolicy).toHaveBeenCalledWith({ projectId: "p1" });
		expect(store().policy).toEqual({ state: "none" });
		expect(store().policyProjectId).toBe("p1");
	});

	it("shows no policy without a project, or when the read fails", async () => {
		useMcpMarketplaceStore.setState({ policy: { state: "none" }, policyProjectId: "p1" });
		await loadMcpPolicy(null);
		expect(store().policy).toBeNull();
		expect(store().policyProjectId).toBeNull();
		expect(api.getMcpInstallPolicy).not.toHaveBeenCalled();

		api.getMcpInstallPolicy.mockResolvedValueOnce({ success: false, error: "x" });
		await loadMcpPolicy("p1");
		expect(store().policy).toBeNull();
		api.getMcpInstallPolicy.mockRejectedValueOnce(new Error("bridge"));
		await loadMcpPolicy("p1");
		expect(store().policy).toBeNull();
	});

	it("drops the answer of a read a later one replaced", async () => {
		let answer: (v: unknown) => void = () => {};
		api.getMcpInstallPolicy.mockImplementationOnce(() => new Promise((r) => (answer = r)));
		api.getMcpInstallPolicy.mockResolvedValueOnce({ success: true, data: { state: "none" } });
		const first = loadMcpPolicy("p1");
		await loadMcpPolicy("p2");
		answer({ success: true, data: { state: "active", policy: { blockCustomServers: true } } });
		await first;
		expect(store().policyProjectId).toBe("p2");
		expect(store().policy).toEqual({ state: "none" });
	});
});

describe("loadInstalledWatch", () => {
	it("keeps the alerts the main read, for its project", async () => {
		api.getMcpInstalledWatch.mockResolvedValue({ success: true, data: VIEW });
		await loadInstalledWatch("p1");
		expect(store().installedWatch).toEqual(VIEW);
		expect(store().watchProjectId).toBe("p1");
	});

	it("shows nothing without a project, after a failed read, or for a replaced read", async () => {
		await loadInstalledWatch(undefined);
		expect(store().installedWatch).toBeNull();
		api.getMcpInstalledWatch.mockResolvedValueOnce({ success: false });
		await loadInstalledWatch("p1");
		expect(store().installedWatch).toBeNull();
		api.getMcpInstalledWatch.mockRejectedValueOnce(new Error("bridge"));
		await loadInstalledWatch("p1");
		expect(store().installedWatch).toBeNull();

		let answer: (v: unknown) => void = () => {};
		api.getMcpInstalledWatch.mockImplementationOnce(() => new Promise((r) => (answer = r)));
		api.getMcpInstalledWatch.mockResolvedValueOnce({ success: true, data: VIEW });
		const first = loadInstalledWatch("p1");
		await loadInstalledWatch("p2");
		answer({ success: true, data: { servers: [] } });
		await first;
		expect(store().watchProjectId).toBe("p2");
		expect(store().installedWatch).toEqual(VIEW);
	});
});

describe("acknowledgeServerAlerts", () => {
	it("acknowledges, then reads the project's alerts again", async () => {
		api.acknowledgeMcpAlerts.mockResolvedValue({ success: true, data: true });
		api.getMcpInstalledWatch.mockResolvedValue({ success: true, data: VIEW });
		expect(await acknowledgeServerAlerts("p1", "git")).toBe(true);
		expect(api.acknowledgeMcpAlerts).toHaveBeenCalledWith({ serverId: "git" });
		expect(store().installedWatch).toEqual(VIEW);
	});

	it("says when the alerts could not be acknowledged", async () => {
		api.acknowledgeMcpAlerts.mockResolvedValueOnce({ success: false, error: "watchServerRequired" });
		expect(await acknowledgeServerAlerts("p1", "git")).toBe(false);
		expect(store().error).toEqual({ key: "acknowledge", detail: "watchServerRequired" });
		api.acknowledgeMcpAlerts.mockRejectedValueOnce(new Error("bridge"));
		expect(await acknowledgeServerAlerts("p1", "git")).toBe(false);
		expect(store().error).toEqual({ key: "acknowledge", detail: "bridge" });
	});
});

describe("an install the policy refuses", () => {
	const git = {
		id: "git",
		name: "Git",
		tagline: { en: "git", fr: "git" },
		transport: "stdio",
		command: "uvx",
		args: ["mcp-server-git"],
		vars: [],
	} as unknown as McpMarketplaceServer;

	it("carries the main's reason, to be said in the app's language", async () => {
		useMcpMarketplaceStore.setState({ catalog: [git] });
		api.getProjectEnv.mockResolvedValue({ success: true, data: {} });
		const refusal = { reason: "notAllowed", serverId: "git", name: "Git" };
		api.updateProjectEnv.mockResolvedValue({
			success: false,
			error: "The project's MCP policy does not allow Git",
			data: { mcpPolicyRefusal: refusal },
		});
		expect(await installMarketplaceServer("p1", "git", {}, ["coder"])).toBe(false);
		expect(store().error).toEqual({ key: "policyRefused", name: "Git", policy: refusal });
		expect(store().installed).toEqual([]);
	});

	it("reads the alerts again after an install", async () => {
		useMcpMarketplaceStore.setState({ catalog: [git] });
		api.getProjectEnv.mockResolvedValue({ success: true, data: {} });
		api.updateProjectEnv.mockResolvedValue({ success: true });
		api.getMcpInstalledWatch.mockResolvedValue({ success: true, data: VIEW });
		expect(await installMarketplaceServer("p1", "git", {}, ["coder"])).toBe(true);
		await vi.waitFor(() => expect(store().installedWatch).toEqual(VIEW));
	});
});
