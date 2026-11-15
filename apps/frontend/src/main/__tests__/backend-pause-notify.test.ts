/** announceBackendPause: the message is read from the task's own pause_state.json. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const announce = vi.fn();

vi.mock("../notification-service", () => ({
	notificationService: { announce: (...args: unknown[]) => announce(...args) },
}));
vi.mock("../app-language", () => ({ getAppLanguage: () => "en" }));

import { announceBackendPause } from "../backend-pause-notify";

let specDir: string;

beforeEach(() => {
	specDir = mkdtempSync(path.join(tmpdir(), "wp-pause-notify-"));
	mkdirSync(specDir, { recursive: true });
	announce.mockReset();
});

afterEach(() => {
	rmSync(specDir, { recursive: true, force: true });
});

describe("announceBackendPause", () => {
	it("announces the circuit breaker's pause", () => {
		writeFileSync(
			path.join(specDir, "pause_state.json"),
			JSON.stringify({
				enabled: true,
				reason: "tool_loop",
				breaker: { tool: "Bash", repeats: 5 },
			}),
		);
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).toHaveBeenCalledWith("proj-1", expect.objectContaining({ title: "Task paused: circuit breaker" }));
	});

	it("stays quiet for the person's own pause", () => {
		writeFileSync(path.join(specDir, "pause_state.json"), JSON.stringify({ enabled: true }));
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).not.toHaveBeenCalled();
	});

	it("stays quiet when there is no pause file, or an unreadable one", () => {
		announceBackendPause("proj-1", specDir, "Add login");
		writeFileSync(path.join(specDir, "pause_state.json"), "{not json");
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).not.toHaveBeenCalled();
	});
});
