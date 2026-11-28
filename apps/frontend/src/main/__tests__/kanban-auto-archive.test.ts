/**
 * The auto-archive pass of the main process: local projects only, the
 * setting read each time, a reload of the board after it archives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ getProjects: vi.fn(), getTasks: vi.fn(), archiveTasks: vi.fn() }));
const settings = vi.hoisted(() => ({ readSettingsFile: vi.fn() }));
const send = vi.hoisted(() => ({ safeSendToRenderer: vi.fn() }));
const log = vi.hoisted(() => ({ appLog: { warn: vi.fn() } }));
vi.mock("../project-store", () => ({ projectStore: store }));
vi.mock("../settings-utils", () => settings);
vi.mock("../ipc-handlers/utils", () => send);
vi.mock("../app-logger", () => log);

import type { Project, Task } from "../../shared/types";
import { type AutoArchiveDeps, archiveFinishedCards, startAutoArchive, stopAutoArchive } from "../kanban-auto-archive";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 28, 12);
const done = (id: string, days: number) =>
	({ id, status: "done", metadata: {}, updatedAt: new Date(NOW - days * DAY).toISOString() }) as unknown as Task;
const local = { id: "p1", path: "/repo" } as Project;

function deps(over: Partial<AutoArchiveDeps> = {}): AutoArchiveDeps {
	return {
		days: () => 7,
		projects: () => [local, { id: "p2", path: "" } as Project, { id: "p3", path: "/r", remote: {} } as unknown as Project],
		tasks: () => [done("old", 10), done("new", 2)],
		archive: vi.fn(() => true),
		reload: vi.fn(),
		now: () => NOW,
		...over,
	};
}

beforeEach(() => {
	for (const fn of [store.getProjects, store.getTasks, store.archiveTasks, settings.readSettingsFile, send.safeSendToRenderer, log.appLog.warn]) {
		fn.mockReset();
	}
});

afterEach(() => {
	stopAutoArchive();
	vi.useRealTimers();
});

describe("archiveFinishedCards", () => {
	it("archives the old done cards of local projects, then reloads their board", () => {
		const d = deps();
		expect(archiveFinishedCards(d)).toBe(1);
		expect(d.archive).toHaveBeenCalledTimes(1);
		expect(d.archive).toHaveBeenCalledWith("p1", ["old"]);
		expect(d.reload).toHaveBeenCalledWith("p1");
	});

	it("does nothing while off, or when no card is old enough", () => {
		const off = deps({ days: () => 0 });
		expect(archiveFinishedCards(off)).toBe(0);
		expect(off.archive).not.toHaveBeenCalled();
		const fresh = deps({ tasks: () => [done("new", 2)] });
		expect(archiveFinishedCards(fresh)).toBe(0);
		expect(fresh.archive).not.toHaveBeenCalled();
	});

	it("says when the archive failed, without reloading", () => {
		const d = deps({ archive: vi.fn(() => false) });
		expect(archiveFinishedCards(d)).toBe(0);
		expect(d.reload).not.toHaveBeenCalled();
		expect(log.appLog.warn).toHaveBeenCalledWith(expect.stringContaining("p1"));
	});
});

describe("startAutoArchive", () => {
	it("looks a while after the start, then every hour, with the saved delay", () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		settings.readSettingsFile.mockReturnValue({ kanbanAutoArchiveDays: 7 });
		store.getProjects.mockReturnValue([local]);
		store.getTasks.mockReturnValue([done("old", 10)]);
		store.archiveTasks.mockReturnValue(true);
		const win = () => null;
		startAutoArchive(win);
		startAutoArchive(win);
		expect(store.archiveTasks).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2 * 60_000);
		expect(store.archiveTasks).toHaveBeenCalledWith("p1", ["old"]);
		expect(send.safeSendToRenderer).toHaveBeenCalledWith(win, expect.any(String), "", "p1", 0);

		store.getProjects.mockImplementation(() => {
			throw new Error("disk");
		});
		vi.advanceTimersByTime(60 * 60_000);
		expect(log.appLog.warn).toHaveBeenCalledWith("[AUTO-ARCHIVE] failed: disk");
		store.getProjects.mockImplementation(() => {
			throw "odd";
		});
		vi.advanceTimersByTime(60 * 60_000);
		expect(log.appLog.warn).toHaveBeenCalledWith("[AUTO-ARCHIVE] failed: odd");

		settings.readSettingsFile.mockReturnValue(undefined);
		store.archiveTasks.mockClear();
		vi.advanceTimersByTime(60 * 60_000);
		expect(store.archiveTasks).not.toHaveBeenCalled();
	});

	it("stops twice without harm", () => {
		stopAutoArchive();
		stopAutoArchive();
	});
});
