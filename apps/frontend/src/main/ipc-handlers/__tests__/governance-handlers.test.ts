/**
 * The governance channels (#353, lot 2): the renderer names a registered
 * project and a format from a closed list; the main reads the runner and
 * writes the export only where the person chose in a native dialog.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const mocks = vi.hoisted(() => ({
	save: vi.fn(),
	writeFile: vi.fn(async () => undefined),
	run: vi.fn(),
	known: vi.fn(),
}));

vi.mock("electron", () => ({
	ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
}));
vi.mock("../../electron-utils", () => ({ showSaveDialog: mocks.save }));
vi.mock("node:fs/promises", () => ({ writeFile: mocks.writeFile }));
vi.mock("../guardrails-handlers", () => ({ runGuardrails: mocks.run }));
vi.mock("../../security/renderer-path", () => ({ resolveKnownProject: mocks.known }));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { exportAudit, governanceReport, registerGovernanceHandlers } from "../governance-handlers";

const event = { id: "a", at: "2026-06-01T08:00:00Z", decision: "deny", rules: ["r"] };

beforeEach(() => {
	handlers.clear();
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.known.mockImplementation((p: unknown) => (p === "/projects/app" ? "/projects/app" : null));
});

describe("governance:report", () => {
	it("reads the runner for a registered project", async () => {
		mocks.run.mockResolvedValue({ governance: null, errors: [], sources: [], tokensLastHour: 0, events: [event, 3] });
		registerGovernanceHandlers();
		const report = await handlers.get(IPC_CHANNELS.GOVERNANCE_REPORT)?.({}, { projectPath: "/projects/app" });
		expect(mocks.run).toHaveBeenCalledWith("governance", { projectPath: "/projects/app" });
		expect((report as { events: unknown[] }).events).toHaveLength(1);
		expect((report as { metrics: unknown }).metrics).toEqual({ blocked24h: 0, breakerTrips7d: 0 });
	});

	it("keeps the trail's counts, bounded", async () => {
		mocks.known.mockReturnValue("/projects/app");
		mocks.run.mockResolvedValue({ events: [], metrics: { blocked24h: 4.7, breakerTrips7d: 1e12 } });
		const report = await governanceReport({ projectPath: "/projects/app" });
		expect(report.metrics).toEqual({ blocked24h: 4, breakerTrips7d: 1_000_000 });
	});

	it("refuses a folder that is not a project of the app", async () => {
		await expect(governanceReport({ projectPath: "/etc" })).rejects.toThrow(/Not a project/);
		await expect(governanceReport(undefined)).rejects.toThrow(/Not a project/);
		expect(mocks.run).not.toHaveBeenCalled();
	});
});

describe("governance:exportAudit", () => {
	it("writes the trail where the person chose", async () => {
		mocks.run.mockResolvedValue({ events: [event] });
		mocks.save.mockResolvedValue({ canceled: false, filePath: "/home/me/audit.csv" });
		registerGovernanceHandlers();
		const result = await handlers.get(IPC_CHANNELS.GOVERNANCE_EXPORT_AUDIT)?.(
			{},
			{ projectPath: "/projects/app", format: "csv" },
		);
		expect(result).toEqual({ filePath: "/home/me/audit.csv", count: 1 });
		expect(mocks.run).toHaveBeenCalledWith("audit", { projectPath: "/projects/app" });
		const [, content] = mocks.writeFile.mock.calls[0] as unknown as [string, string];
		expect(content.split("\r\n")[1]).toContain("deny");
	});

	it("names the file by the day and the format", async () => {
		mocks.run.mockResolvedValue({ events: [] });
		mocks.save.mockResolvedValue({ canceled: true });
		const result = await exportAudit({ projectPath: "/projects/app", format: "json" }, new Date("2026-06-01T10:00:00Z"));
		expect(result).toBeNull();
		expect(mocks.save.mock.calls[0][0].defaultPath).toBe("policy-audit-2026-06-01.json");
		expect(mocks.writeFile).not.toHaveBeenCalled();
	});

	it("writes nothing without a chosen path", async () => {
		mocks.run.mockResolvedValue({ events: [] });
		mocks.save.mockResolvedValue({ canceled: false, filePath: "" });
		expect(await exportAudit({ projectPath: "/projects/app", format: "json" })).toBeNull();
		expect(mocks.writeFile).not.toHaveBeenCalled();
	});

	it("refuses an unknown format before reading anything", async () => {
		await expect(exportAudit({ projectPath: "/projects/app", format: "../../x" })).rejects.toThrow(/csv or json/);
		expect(mocks.run).not.toHaveBeenCalled();
		expect(mocks.save).not.toHaveBeenCalled();
	});
});
