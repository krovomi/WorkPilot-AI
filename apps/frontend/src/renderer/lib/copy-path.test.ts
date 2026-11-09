import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPath, hostPath } from "./copy-path";

const g = globalThis as unknown as { electronAPI?: unknown };

describe("copyPath", () => {
	const writeText = vi.fn().mockResolvedValue(undefined);

	afterEach(() => {
		g.electronAPI = undefined;
		writeText.mockClear();
		vi.unstubAllGlobals();
	});

	it("copie le chemin traduit par le main (Windows sous WSL)", async () => {
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		g.electronAPI = {
			toHostPath: vi.fn().mockResolvedValue("\\\\wsl.localhost\\Ubuntu\\home\\x\\f.cs"),
		};
		await copyPath("/home/x/f.cs");
		expect(writeText).toHaveBeenCalledWith("\\\\wsl.localhost\\Ubuntu\\home\\x\\f.cs");
	});

	it("copie le chemin tel quel sans main ou si la traduction échoue", async () => {
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		await copyPath("/home/x/f.cs");
		expect(writeText).toHaveBeenLastCalledWith("/home/x/f.cs");

		g.electronAPI = { toHostPath: vi.fn().mockRejectedValue(new Error("ipc")) };
		expect(await hostPath("/home/x/f.cs")).toBe("/home/x/f.cs");
		g.electronAPI = { toHostPath: vi.fn().mockResolvedValue("") };
		expect(await hostPath("/home/x/f.cs")).toBe("/home/x/f.cs");
	});
});
