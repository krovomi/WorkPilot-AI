/**
 * The team report of "How you compare": the renderer's worded document is
 * read again as strings, printed to a PDF only where the person chose in a
 * save dialog, and refused when it is not a report.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

const mocks = vi.hoisted(() => ({
	save: vi.fn(),
	write: vi.fn(),
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend" },
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
			mocks.handlers.set(channel, handler),
	},
	BrowserWindow: vi.fn(),
}));
vi.mock("../electron-utils", () => ({ showSaveDialog: mocks.save }));
vi.mock("../app-language", () => ({ getAppLanguage: () => "fr" }));
vi.mock("../compliance/report-export", async (importOriginal) => ({
	...(await importOriginal<typeof import("../compliance/report-export")>()),
	writeExport: mocks.write,
}));
vi.mock("../project-store", () => ({ projectStore: { getProjects: () => [] } }));

import { exportComparisonReport, readReport } from "../build-compare-report";
import { registerBuildCompareHandlers } from "../ipc-handlers/build-compare-handlers";

const report = {
	title: "Où vous en êtes : rapport d'équipe",
	summary: ["Segment : go, Petit dépôt, Solo.", 3],
	tables: [{ title: "Où vous en êtes", columns: ["Par spec", "Ce projet"], rows: [["Durée", "<b>12 min</b>"]] }],
};

beforeEach(() => {
	mocks.save.mockReset();
	mocks.write.mockReset();
});

describe("readReport", () => {
	it("keeps a report's strings, and refuses one without a title or a table", () => {
		expect(readReport(report)?.summary).toEqual(["Segment : go, Petit dépôt, Solo.", "3"]);
		expect(readReport(null)).toBeNull();
		expect(readReport([report])).toBeNull();
		expect(readReport({ ...report, title: "  " })).toBeNull();
		expect(readReport({ ...report, title: 4 })).toBeNull();
		expect(readReport({ ...report, tables: [] })).toBeNull();
	});
});

describe("exportComparisonReport", () => {
	it("refuses what is not a report, before any dialog", async () => {
		expect(await exportComparisonReport({ title: "x" })).toEqual({ success: false, error: "Nothing to export" });
		expect(mocks.save).not.toHaveBeenCalled();
	});

	it("prints the report where the person chose, in the app's language", async () => {
		mocks.save.mockResolvedValue({ canceled: false, filePath: "/chosen/report.pdf" });
		expect(await exportComparisonReport(report)).toEqual({ success: true, data: "/chosen/report.pdf" });
		const [options] = mocks.save.mock.calls[0];
		expect(options.defaultPath).toMatch(/^how-you-compare-\d{4}-\d{2}-\d{2}\.pdf$/);
		const [format, request, filePath] = mocks.write.mock.calls[0];
		expect(format).toBe("pdf");
		expect(filePath).toBe("/chosen/report.pdf");
		expect(request).toMatchObject({ report: null, language: "fr" });
		expect(request.document.tables[0].rows).toEqual([["Durée", "<b>12 min</b>"]]);
	});

	it("writes nothing when the person cancels", async () => {
		mocks.save.mockResolvedValueOnce({ canceled: true, filePath: "/x.pdf" });
		mocks.save.mockResolvedValueOnce({ canceled: false });
		expect(await exportComparisonReport(report)).toEqual({ success: true, data: null });
		expect(await exportComparisonReport(report)).toEqual({ success: true, data: null });
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("reports a print that fails", async () => {
		mocks.save.mockResolvedValue({ canceled: false, filePath: "/chosen/report.pdf" });
		mocks.write.mockRejectedValueOnce(new Error("EACCES"));
		mocks.write.mockRejectedValueOnce("odd");
		expect(await exportComparisonReport(report)).toEqual({ success: false, error: "EACCES" });
		expect(await exportComparisonReport(report)).toEqual({ success: false, error: "odd" });
	});

	it("is the handler of its channel", async () => {
		registerBuildCompareHandlers();
		const handler = mocks.handlers.get(IPC_CHANNELS.DASHBOARD_COMPARE_EXPORT);
		expect(await handler?.({}, "not a report")).toEqual({ success: false, error: "Nothing to export" });
	});
});
