/**
 * The analyses of a server project run on the server: the view's handler
 * starts the job, tells the view its progress on its own channels, and reads
 * the report the server saved, which every member reads too. Nothing runs on
 * this computer and no path goes to the server.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../shared/types";

const mocks = vi.hoisted(() => ({
	authedFetch: vi.fn(),
	relayServerJob: vi.fn(),
	serverProjectAtPath: vi.fn(),
	send: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
	BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] },
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
}));
vi.mock("../../server-connection", () => ({ authedFetch: mocks.authedFetch }));
vi.mock("../../server-features", () => ({ relayServerJob: mocks.relayServerJob }));
vi.mock("../../server-projects", () => ({
	serverProjectAtPath: mocks.serverProjectAtPath,
}));

import {
	cancelServerAnalysis,
	registerServerAnalysisHandlers,
	relayServerAnalysis,
	runServerAnalysis,
	serverAnalysisReport,
} from "../server-analyses";

const project = { id: "p-1", path: "/mirror/p-1", remote: {} } as unknown as Project;
const channels = { event: "ev", result: "res", error: "err" };

function saved(report: unknown) {
	return JSON.stringify({
		analysis: "accessibility",
		report,
		finished_at: "2026-11-01T01:00:00+00:00",
		run_by: "u-ada",
	});
}

function job() {
	const stream = Object.assign(new EventEmitter(), {
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(() => true),
	});
	mocks.relayServerJob.mockReturnValueOnce(stream);
	return stream;
}

beforeEach(() => {
	mocks.authedFetch.mockReset();
	mocks.relayServerJob.mockReset();
	mocks.serverProjectAtPath.mockReset();
	mocks.send.mockReset();
});

describe("a server project's analyses", () => {
	it("reads the last saved report by project id", async () => {
		mocks.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { report: saved({ violations: 2 }) },
		});
		expect(await serverAnalysisReport(project, "accessibility")).toEqual({
			report: { violations: 2 },
			finishedAt: "2026-11-01T01:00:00+00:00",
			runBy: "u-ada",
		});
		expect(mocks.authedFetch).toHaveBeenCalledWith(
			"/api/features/analyses/accessibility/report?project_id=p-1",
			"GET",
		);
		for (const answer of [
			{ ok: true, data: { report: null } },
			{ ok: true, data: { report: "not json" } },
			{ ok: true, data: { report: "[1]" } },
			{ ok: false, error: "down" },
		]) {
			mocks.authedFetch.mockResolvedValueOnce(answer);
			expect(await serverAnalysisReport(project, "i18n")).toBeNull();
		}
	});

	it("runs on the server, tells the view its progress, then its report", async () => {
		const stream = job();
		const done = relayServerAnalysis(project, "accessibility", { target_level: "AAA" }, channels);
		expect(mocks.relayServerJob).toHaveBeenCalledWith(project, "analyses/accessibility", {
			options: { target_level: "AAA" },
		});
		stream.stdout.emit(
			"data",
			Buffer.from(
				'A11Y_EVENT:{"type":"progress","data":{"status":"Scanning"}}\nA11Y_RESULT:{"cut',
			),
		);
		expect(mocks.send).toHaveBeenCalledWith("ev", {
			type: "progress",
			data: { status: "Scanning" },
		});
		mocks.authedFetch.mockResolvedValueOnce({
			ok: true,
			data: { report: saved({ violations: 1 }) },
		});
		stream.emit("exit", 0);
		expect(await done).toEqual({ violations: 1 });
		expect(mocks.send).toHaveBeenLastCalledWith("res", { violations: 1 });
	});

	it("says why it failed, and stops one that runs", async () => {
		const failing = job();
		const failed = relayServerAnalysis(project, "i18n", {}, channels);
		failing.stdout.emit("data", Buffer.from("I18N_ERROR:no locales found\n"));
		failing.emit("exit", 1);
		await expect(failed).rejects.toThrow("no locales found");
		expect(mocks.send).toHaveBeenLastCalledWith("err", "no locales found");

		const running = job();
		const stopped = runServerAnalysis(project, "doc-drift", {});
		expect(cancelServerAnalysis("doc-drift")).toBe(true);
		expect(running.kill).toHaveBeenCalled();
		expect(cancelServerAnalysis("doc-drift")).toBe(false);
		running.emit("exit", null);
		await expect(stopped).rejects.toThrow("stopped");
	});

	it("a run replaced by a new one is not told to the view as an error", async () => {
		const first = job();
		const replaced = relayServerAnalysis(project, "flaky-tests", {}, channels);
		const second = job();
		const next = relayServerAnalysis(project, "flaky-tests", {}, channels);
		expect(first.kill).toHaveBeenCalled();
		first.emit("exit", null);
		await expect(replaced).rejects.toThrow("stopped");
		expect(mocks.send).not.toHaveBeenCalledWith("err", expect.anything());
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { report: saved([]) } });
		second.emit("exit", 0);
		expect(await next).toEqual([]);
	});

	it("a run that ends without a report is an error", async () => {
		const stream = job();
		const run = runServerAnalysis(project, "tech-debt", {});
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { report: null } });
		stream.emit("exit", 0);
		await expect(run).rejects.toThrow("without a report");
	});

	it("serves a view the shared report of a server project only", async () => {
		registerServerAnalysisHandlers();
		const handler = [...mocks.handlers.values()][0];
		mocks.serverProjectAtPath.mockReturnValue(undefined);
		expect(await handler({}, "accessibility", "/local/project")).toBeNull();
		mocks.serverProjectAtPath.mockReturnValue(project);
		expect(await handler({}, "../roadmap", "/mirror/p-1")).toBeNull();
		expect(mocks.authedFetch).not.toHaveBeenCalled();
		mocks.authedFetch.mockResolvedValueOnce({ ok: true, data: { report: saved([]) } });
		expect(await handler({}, "flaky-tests", "/mirror/p-1")).toMatchObject({ report: [] });
	});
});
