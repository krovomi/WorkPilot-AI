/**
 * The Pixel Office bridge: one constant channel per call, its arguments as given.
 */

import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
	ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

import { IPC_CHANNELS } from "../../../../shared/constants/ipc";
import { createPixelOfficeAPI } from "../pixel-office-api";

describe("pixel office bridge", () => {
	it("sends a scene request on its own channel", async () => {
		invoke.mockResolvedValue({ success: true, text: "Done." });
		const request = { kind: "shipped" as const, spec: "042", language: "en" as const };
		await expect(createPixelOfficeAPI().narrate(request)).resolves.toEqual({
			success: true,
			text: "Done.",
		});
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.PIXEL_OFFICE_NARRATE, request);
	});

	it("asks for the team board and saves the consent on their own channels", async () => {
		const api = createPixelOfficeAPI();
		invoke.mockResolvedValue({ success: false, error: "x" });
		await api.getTeamBoard("p1", { scope: "org", period: "all" });
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.PIXEL_OFFICE_TEAM_BOARD, "p1", {
			scope: "org",
			period: "all",
		});
		await api.setTeamConsent("p1", true);
		expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.PIXEL_OFFICE_TEAM_CONSENT, "p1", true);
	});
});
