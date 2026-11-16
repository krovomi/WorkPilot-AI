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

	it("announces the anomaly watch's pause, and says when files were restored", () => {
		const write = (anomaly: Record<string, unknown>) =>
			writeFileSync(
				path.join(specDir, "pause_state.json"),
				JSON.stringify({ enabled: true, reason: "anomaly", anomaly }),
			);
		write({ trustScore: 38.5, stopped: false, anomalies: [] });
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).toHaveBeenLastCalledWith(
			"proj-1",
			expect.objectContaining({
				title: "Task paused: unusual agent behaviour",
				body: expect.stringContaining("39/100"),
			}),
		);
		write({ trustScore: 10, stopped: true, rolledBack: true, anomalies: [] });
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).toHaveBeenLastCalledWith(
			"proj-1",
			expect.objectContaining({ body: expect.stringContaining("restored") }),
		);
	});

	it("announces a sandbox pause, and ignores one without its detail", () => {
		writeFileSync(
			path.join(specDir, "pause_state.json"),
			JSON.stringify({ enabled: true, reason: "sandbox", sandbox: { kind: "files_written" } }),
		);
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).toHaveBeenCalledWith("proj-1", expect.objectContaining({ title: "Task paused: sandbox limit" }));
		announce.mockReset();
		writeFileSync(path.join(specDir, "pause_state.json"), JSON.stringify({ enabled: true, reason: "sandbox" }));
		announceBackendPause("proj-1", specDir, "Add login");
		writeFileSync(
			path.join(specDir, "pause_state.json"),
			JSON.stringify({ enabled: true, reason: "anomaly", anomaly: { trustScore: "low" } }),
		);
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).not.toHaveBeenCalled();
		writeFileSync(
			path.join(specDir, "pause_state.json"),
			JSON.stringify({
				enabled: true,
				reason: "sandbox",
				sandbox: { kind: "restricted_path", rolledBack: true },
			}),
		);
		announceBackendPause("proj-1", specDir, "Add login");
		expect(announce).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({ body: expect.stringContaining("restored") }),
		);
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
