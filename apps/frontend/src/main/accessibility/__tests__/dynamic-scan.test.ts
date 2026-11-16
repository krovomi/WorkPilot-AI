/**
 * @vitest-environment node
 *
 * The scan opens no window on the port of a WorkPilot service: the backend
 * the main uses and its WebSocket. Another local port is still scanned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	backendUrl: "http://127.0.0.1:9000",
	windows: vi.fn(),
}));

vi.mock("electron", () => ({
	BrowserWindow: class {
		constructor() {
			state.windows();
			throw new Error("window opened");
		}
	},
	session: {
		fromPartition: () => ({ setPermissionRequestHandler: vi.fn() }),
	},
}));
vi.mock("../../ipc-handlers/_backend-fetch", () => ({
	getBackendUrl: () => state.backendUrl,
}));

import { runDynamicScan, workpilotServicePorts } from "../dynamic-scan";

const REFUSED =
	"Only an app running on this computer (localhost), other than WorkPilot's own services, can be scanned.";

beforeEach(() => {
	state.backendUrl = "http://127.0.0.1:9000";
	state.windows.mockClear();
});

describe("WorkPilot's own services", () => {
	it("are the backend's port and the WebSocket's", () => {
		expect([...workpilotServicePorts()].sort()).toEqual([8765, 9000]);
	});

	it("follow the backend URL the main uses", () => {
		state.backendUrl = "http://localhost:9100";
		expect(workpilotServicePorts().has(9100)).toBe(true);
		expect(workpilotServicePorts().has(9000)).toBe(false);
	});

	it.each(["http://127.0.0.1:9000/providers", "http://localhost:8765/"])(
		"refuses %s before any window opens",
		async (url) => {
			await expect(runDynamicScan(url, "AA")).rejects.toThrow(REFUSED);
			expect(state.windows).not.toHaveBeenCalled();
		},
	);

	it("still opens another local port", async () => {
		await expect(runDynamicScan("http://localhost:3000/", "AA")).rejects.toThrow("window opened");
		expect(state.windows).toHaveBeenCalledOnce();
	});
});
