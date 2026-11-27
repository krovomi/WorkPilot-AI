/**
 * The usage bridge sends a view's name one way, and the settings on their own
 * channels; the main checks each of them again.
 */
import { describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(async () => null), send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: ipc }));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createServerUsageAPI } from "../server-usage-api";

describe("createServerUsageAPI", () => {
	it("names a view, reads and saves the settings", async () => {
		const api = createServerUsageAPI();
		api.notePageVisit("kanban");
		expect(ipc.send).toHaveBeenCalledWith(IPC_CHANNELS.SERVER_USAGE_PAGE_VISIT, "kanban");
		await api.getUsageSettings();
		expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SERVER_USAGE_GET_SETTINGS);
		const body = { page_activity: true, usage_retention_days: null, page_activity_retention_days: 90 };
		await api.setUsageSettings(body);
		expect(ipc.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SERVER_USAGE_SET_SETTINGS, body);
	});
});
