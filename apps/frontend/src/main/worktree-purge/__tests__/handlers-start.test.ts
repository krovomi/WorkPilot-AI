/**
 * Registering the « Purger » handlers also starts the board's housekeeping:
 * the merged-PR watch and the auto-archive of finished cards.
 */
import { describe, expect, it, vi } from "vitest";

const watch = vi.hoisted(() => ({ startMergedWatch: vi.fn() }));
const archive = vi.hoisted(() => ({ startAutoArchive: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../merged-watch", () => watch);
vi.mock("../../kanban-auto-archive", () => archive);
vi.mock("../../project-store", () => ({ projectStore: {} }));
vi.mock("../purge", () => ({ listPurgeCandidates: vi.fn(), purgeWorktrees: vi.fn() }));

import { registerWorktreePurgeHandlers } from "../handlers";

describe("registerWorktreePurgeHandlers", () => {
	it("starts the merged-PR watch and the auto-archive", () => {
		const win = () => null;
		registerWorktreePurgeHandlers(win);
		expect(watch.startMergedWatch).toHaveBeenCalledWith(win);
		expect(archive.startAutoArchive).toHaveBeenCalledWith(win);
	});
});
