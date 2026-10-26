/**
 * A pass the main process announces moves the panel's counter, and reloads
 * the board only when it created cards for the project on screen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationsEvent } from "../../../shared/types";

const loadTasks = vi.hoisted(() => vi.fn());
vi.mock("../task-store", () => ({ loadTasks }));
vi.mock("../project-store", () => ({
	useProjectStore: { getState: () => ({ selectedProjectId: "p1" }) },
}));

import { setupAutomationsListeners, useAutomationsStore } from "../automations-store";

let emit: (event: AutomationsEvent) => void = () => undefined;
Object.defineProperty(globalThis, "electronAPI", {
	value: {
		automations: {
			onEvent: (callback: (event: AutomationsEvent) => void) => {
				emit = callback;
				return () => undefined;
			},
		},
	},
	writable: true,
	configurable: true,
});

describe("automations listeners", () => {
	beforeEach(() => {
		loadTasks.mockClear();
		useAutomationsStore.setState({ passes: {} });
	});

	it("reloads the open project's board when cards were created", () => {
		setupAutomationsListeners();
		emit({ projectId: "p1", created: 2 });
		expect(loadTasks).toHaveBeenCalledWith("p1", { forceRefresh: true });
		expect(useAutomationsStore.getState().passes).toEqual({ p1: 1 });
	});

	it("only counts a pass that created nothing, or another project's", () => {
		setupAutomationsListeners();
		emit({ projectId: "p1", created: 0 });
		emit({ projectId: "p2", created: 3 });
		expect(loadTasks).not.toHaveBeenCalled();
		expect(useAutomationsStore.getState().passes).toEqual({ p1: 1, p2: 1 });
	});
});
