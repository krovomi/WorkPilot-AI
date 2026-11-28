/** @vitest-environment jsdom */
/**
 * The tech debt store: reads and scans per project, an answer for a project
 * the view has left is dropped, and a debt item becomes a Kanban task.
 */

import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DebtItem, DebtReport } from "../../../preload/api/modules/tech-debt-api";
import i18n from "../../../shared/i18n";
import { useTechDebtStore } from "../tech-debt-store";

const mockScan = vi.fn();
const mockList = vi.fn();
const mockCreateTask = vi.fn();

const ITEM: DebtItem = {
	id: "x",
	kind: "duplication",
	file_path: "a.cs",
	line: 3,
	message: "m",
	cost: 10,
	effort: 2,
	roi: 5,
	tags: [],
	context: "",
};

const report = (path: string, total = 1): DebtReport => ({
	project_path: path,
	scanned_at: 123,
	items: Array.from({ length: total }, (_, i) => ({ ...ITEM, id: `${path}-${i}` })),
	trend: [{ timestamp: 123, total_items: total, total_cost: 2, avg_roi: 2 }],
	summary: { total, by_kind: { duplication: total }, total_cost: 2, total_effort: 1, avg_roi: 2 },
});

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const store = () => useTechDebtStore.getState();

beforeEach(async () => {
	vi.clearAllMocks();
	(globalThis as { electronAPI?: unknown }).electronAPI = {
		scanTechDebt: mockScan,
		listDebtItems: mockList,
		createTask: mockCreateTask,
	};
	await i18n.changeLanguage("en");
	store().clear();
});

describe("tech-debt-store", () => {
	it("starts empty, with default filters, for no project", () => {
		expect(store()).toMatchObject({
			projectPath: null,
			items: [],
			trend: [],
			summary: null,
			error: null,
			scanning: false,
			lastScannedAt: null,
			filters: { minScore: 0, search: "" },
		});
	});

	it("updates one filter at a time and clear() restores the defaults", () => {
		act(() => store().setFilter("minScore", 3));
		act(() => store().setFilter("search", "auth"));
		expect(store().filters).toEqual({ minScore: 3, search: "auth" });
		act(() => store().clear());
		expect(store().filters).toEqual({ minScore: 0, search: "" });
	});

	it("scans a project and keeps its report, scanning while it runs", async () => {
		const answer = deferred<{ result: DebtReport }>();
		mockScan.mockReturnValueOnce(answer.promise);
		const running = store().scan("/p");
		expect(store()).toMatchObject({ projectPath: "/p", scanning: true });
		answer.resolve({ result: report("/p") });
		await running;
		expect(mockScan).toHaveBeenCalledWith({ projectPath: "/p" });
		expect(store()).toMatchObject({ scanning: false, lastScannedAt: 123, error: null });
		expect(store().items).toHaveLength(1);
		expect(store().summary?.total).toBe(1);
	});

	it("reports a failed scan, Error or not", async () => {
		mockScan.mockRejectedValueOnce(new Error("io failure"));
		await store().scan("/p");
		expect(store()).toMatchObject({ scanning: false, error: "io failure" });

		mockScan.mockRejectedValueOnce("backend gone");
		await store().scan("/p");
		expect(store().error).toBe("backend gone");
	});

	it("reads the saved items with the minimum score and keeps the last scan time", async () => {
		mockScan.mockResolvedValueOnce({ result: report("/p") });
		await store().scan("/p");
		act(() => store().setFilter("minScore", 2));
		mockList.mockResolvedValueOnce({ result: report("/p", 3) });
		await store().refresh("/p");
		expect(mockList).toHaveBeenCalledWith({ projectPath: "/p", minScore: 2 });
		expect(store().items).toHaveLength(3);
		expect(store().lastScannedAt).toBe(123);
	});

	it("reports a failed read", async () => {
		mockList.mockRejectedValueOnce(new Error("no such project"));
		await store().refresh("/p");
		expect(store().error).toBe("no such project");
	});

	it("empties the view when another project is read, before the answer arrives", async () => {
		mockScan.mockResolvedValueOnce({ result: report("/a", 2) });
		await store().scan("/a");
		const answer = deferred<{ result: DebtReport }>();
		mockList.mockReturnValueOnce(answer.promise);
		const reading = store().refresh("/b");
		expect(store()).toMatchObject({ projectPath: "/b", items: [], summary: null, lastScannedAt: null });
		answer.resolve({ result: report("/b", 1) });
		await reading;
		expect(store().items.map((i) => i.id)).toEqual(["/b-0"]);
	});

	it("keeps the view of the same project while it is read again", async () => {
		mockScan.mockResolvedValueOnce({ result: report("/a", 2) });
		await store().scan("/a");
		const answer = deferred<{ result: DebtReport }>();
		mockList.mockReturnValueOnce(answer.promise);
		const reading = store().refresh("/a");
		expect(store().items).toHaveLength(2);
		answer.resolve({ result: report("/a", 2) });
		await reading;
	});

	it("drops a scan, a read or a failure that answers for a project the view has left", async () => {
		const scanA = deferred<{ result: DebtReport }>();
		const listA = deferred<{ result: DebtReport }>();
		const failA = deferred<{ result: DebtReport }>();
		const failListA = deferred<{ result: DebtReport }>();
		mockScan.mockReturnValueOnce(scanA.promise).mockReturnValueOnce(failA.promise);
		mockList
			.mockReturnValueOnce(listA.promise)
			.mockReturnValueOnce(failListA.promise)
			.mockResolvedValueOnce({ result: report("/b") });
		const pending = [store().scan("/a"), store().refresh("/a"), store().scan("/a"), store().refresh("/a")];
		await store().refresh("/b");

		scanA.resolve({ result: report("/a", 5) });
		listA.resolve({ result: report("/a", 5) });
		failA.reject(new Error("late"));
		failListA.reject(new Error("late too"));
		await Promise.all(pending);

		expect(store()).toMatchObject({ projectPath: "/b", error: null });
		expect(store().items.map((i) => i.id)).toEqual(["/b-0"]);
	});

	it("drops an old scan of a project the view left and came back to", async () => {
		const oldScan = deferred<{ result: DebtReport }>();
		const newScan = deferred<{ result: DebtReport }>();
		mockScan.mockReturnValueOnce(oldScan.promise).mockReturnValueOnce(newScan.promise);
		mockList.mockResolvedValueOnce({ result: report("/b") });
		const first = store().scan("/a");
		await store().refresh("/b");
		const second = store().scan("/a");

		oldScan.resolve({ result: report("/a", 5) });
		await first;
		expect(store()).toMatchObject({ projectPath: "/a", scanning: true, items: [] });

		newScan.resolve({ result: report("/a", 2) });
		await second;
		expect(store()).toMatchObject({ scanning: false });
		expect(store().items).toHaveLength(2);
	});

	it("drops an answer that arrives after the view was cleared", async () => {
		const answer = deferred<{ result: DebtReport }>();
		mockScan.mockReturnValueOnce(answer.promise);
		const scanning = store().scan("/a");
		store().clear();
		answer.resolve({ result: report("/a") });
		await scanning;
		expect(store()).toMatchObject({ projectPath: null, items: [], scanning: false });
	});

	it("turns a debt item into a backlog task", async () => {
		const createdTask = { id: "task-42", title: "Tech debt : m", projectId: "proj-1" };
		mockCreateTask.mockResolvedValueOnce({ success: true, data: createdTask });

		const task = await store().createTaskFromItem("proj-1", { ...ITEM, context: "dup()" }, "en");

		expect(mockCreateTask).toHaveBeenCalledWith(
			"proj-1",
			expect.stringContaining("Tech debt"),
			expect.stringContaining("Location: `a.cs:3`"),
			expect.objectContaining({
				sourceType: "tech-debt",
				acceptanceCriteria: expect.arrayContaining([expect.stringContaining("next tech debt scan")]),
			}),
		);
		expect(mockCreateTask.mock.calls[0][2]).toContain("### Context\n\n```\ndup()\n```");
		expect(task?.id).toBe("task-42");
		expect(store().error).toBeNull();
	});

	it("says so when the task could not be created", async () => {
		mockCreateTask.mockResolvedValueOnce({ success: false, error: "disk full" });
		expect(await store().createTaskFromItem("proj-1", ITEM, "en")).toBeNull();
		expect(store().error).toBe("Could not create the task from this debt item");
	});

	it("shows an error the dashboard found, and clears it", () => {
		act(() => store().setError("No project selected"));
		expect(store().error).toBe("No project selected");
		act(() => store().setError(null));
		expect(store().error).toBeNull();
	});
});
