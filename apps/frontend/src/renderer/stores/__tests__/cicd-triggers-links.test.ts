/**
 * The CI/CD store's linked services, figures and verdict reviews (#366, lot 4):
 * each answer lands on the project it was asked for, and an error shows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCICDTriggersStore } from "../cicd-triggers-store";

const links = { linked: [{ id: "p2", name: "web" }], candidates: [] };
const api = {
	invoke: vi.fn(async () => ({ success: true, data: [] })),
	getDeployLinks: vi.fn(),
	setDeployLinks: vi.fn(),
	getDeployFigures: vi.fn(),
	reviewDeployVerdict: vi.fn(),
};

beforeEach(async () => {
	for (const fn of Object.values(api)) fn.mockReset();
	api.invoke.mockResolvedValue({ success: true, data: [] });
	api.getDeployLinks.mockResolvedValue({ success: true, data: links });
	api.setDeployLinks.mockResolvedValue({ success: true, data: links });
	api.getDeployFigures.mockResolvedValue({ success: true, data: { watches: 2 } });
	api.reviewDeployVerdict.mockResolvedValue({ success: true });
	(globalThis as unknown as { electronAPI: unknown }).electronAPI = api;
	useCICDTriggersStore.setState({ error: null, links: null, figures: null });
	await useCICDTriggersStore.getState().loadRuns("/p");
});

describe("links and figures", () => {
	it("reads and saves the links, reads the figures", async () => {
		await useCICDTriggersStore.getState().loadLinks("/p");
		expect(useCICDTriggersStore.getState().links).toEqual(links);
		await useCICDTriggersStore.getState().saveLinks("/p", ["p2"]);
		expect(api.setDeployLinks).toHaveBeenCalledWith("/p", ["p2"]);
		await useCICDTriggersStore.getState().loadFigures("/p");
		expect(useCICDTriggersStore.getState().figures).toEqual({ watches: 2 });
	});

	it("shows the main's refusal, or a generic one, or a bridge that throws", async () => {
		api.setDeployLinks.mockResolvedValueOnce({ success: false, error: "invalid-links" });
		await useCICDTriggersStore.getState().saveLinks("/p", ["x"]);
		expect(useCICDTriggersStore.getState().error).toBe("invalid-links");
		api.getDeployFigures.mockResolvedValueOnce({ success: false });
		await useCICDTriggersStore.getState().loadFigures("/p");
		expect(useCICDTriggersStore.getState().error).toBe("Request failed");
		api.getDeployLinks.mockImplementationOnce(() => {
			throw new Error("bridge down");
		});
		await useCICDTriggersStore.getState().loadLinks("/p");
		expect(useCICDTriggersStore.getState().error).toBe("Error: bridge down");
	});

	it("drops what comes back for a project left behind", async () => {
		let release: (value: unknown) => void = vi.fn();
		let fail: (reason: unknown) => void = vi.fn();
		api.setDeployLinks
			.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
			.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
		const pending = [
			useCICDTriggersStore.getState().saveLinks("/p", ["p2"]),
			useCICDTriggersStore.getState().saveLinks("/p", ["p3"]),
		];
		await useCICDTriggersStore.getState().loadRuns("/other");
		release({ success: true, data: links });
		fail(new Error("late"));
		await Promise.all(pending);
		expect(useCICDTriggersStore.getState()).toMatchObject({ links: null, error: null });
	});
});

describe("reviewVerdict", () => {
	it("records the word, then reads the runs and the figures again", async () => {
		api.invoke.mockClear();
		await useCICDTriggersStore.getState().reviewVerdict("/p", "42", "false_positive");
		expect(api.reviewDeployVerdict).toHaveBeenCalledWith("/p", "42", "false_positive");
		expect(api.invoke).toHaveBeenCalledWith("cicdTriggers:listRuns", "/p", 50);
		expect(api.getDeployFigures).toHaveBeenCalledWith("/p");
	});

	it("reads nothing again once another project is shown", async () => {
		let release: (value: unknown) => void = vi.fn();
		api.reviewDeployVerdict.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
		const pending = useCICDTriggersStore.getState().reviewVerdict("/p", "42", null);
		await useCICDTriggersStore.getState().loadRuns("/other");
		release({ success: true });
		await pending;
		expect(api.getDeployFigures).not.toHaveBeenCalled();
	});
});
