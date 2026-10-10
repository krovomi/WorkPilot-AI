/**
 * Auto-Refactor forwarding, exercised: the service's events reach the window
 * `getMainWindow` returns, once each however many times forwarding is set up,
 * and an `"error"` no longer throws for want of a listener.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/tmp") },
	ipcMain: { handle: vi.fn() },
}));

import { autoRefactorService } from "../../auto-refactor-service";
import { setupAutoRefactorEventForwarding } from "../auto-refactor-handlers";

describe("setupAutoRefactorEventForwarding", () => {
	it("sends each service event to the current window, once", () => {
		const send = vi.fn();
		const window = { isDestroyed: () => false, webContents: { send } };
		const getMainWindow = vi.fn(() => window as never);

		setupAutoRefactorEventForwarding(getMainWindow);
		setupAutoRefactorEventForwarding(getMainWindow);

		autoRefactorService.emit("status", "Analysing…");
		expect(() =>
			autoRefactorService.emit("error", "Failed to start auto-refactor"),
		).not.toThrow();

		expect(send.mock.calls).toEqual([
			["auto-refactor:status", "Analysing…"],
			["auto-refactor:error", "Failed to start auto-refactor"],
		]);
	});
});
