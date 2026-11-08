import { beforeEach, describe, expect, it, vi } from "vitest";

const manager = vi.hoisted(() => ({
	getPythonPath: vi.fn<() => string | null>(),
	initialize: vi.fn(),
}));
const source = vi.hoisted(() => ({ path: "/app/backend" as string }));

vi.mock("../../python-env-manager", () => ({ pythonEnvManager: manager }));
vi.mock("../../updater/path-resolver", () => ({ getEffectiveSourcePath: () => source.path }));

import { readyPythonPath, requirePythonPath } from "../ensure-python";

describe("ensure-python", () => {
	beforeEach(() => {
		manager.getPythonPath.mockReset();
		manager.initialize.mockReset();
		source.path = "/app/backend";
	});

	it("returns the managed Python without initializing when it is ready", async () => {
		manager.getPythonPath.mockReturnValue("/venv/bin/python");
		await expect(requirePythonPath()).resolves.toBe("/venv/bin/python");
		expect(manager.initialize).not.toHaveBeenCalled();
	});

	it("initializes the environment when no task has run yet (F168)", async () => {
		manager.getPythonPath.mockReturnValue(null);
		manager.initialize.mockResolvedValue({ ready: true, pythonPath: "/venv/bin/python" });
		await expect(requirePythonPath()).resolves.toBe("/venv/bin/python");
		expect(manager.initialize).toHaveBeenCalledWith("/app/backend");
	});

	it("throws with the cause when the initialization fails", async () => {
		manager.getPythonPath.mockReturnValue(null);
		manager.initialize.mockResolvedValue({ ready: false, pythonPath: null, error: "pip failed" });
		await expect(requirePythonPath()).rejects.toThrow("Python environment not ready: pip failed");
		await expect(readyPythonPath()).resolves.toBeNull();
	});

	it("says so when the backend cannot be found", async () => {
		manager.getPythonPath.mockReturnValue(null);
		source.path = "";
		await expect(requirePythonPath()).rejects.toThrow(/backend not found/);
		expect(manager.initialize).not.toHaveBeenCalled();
	});
});
