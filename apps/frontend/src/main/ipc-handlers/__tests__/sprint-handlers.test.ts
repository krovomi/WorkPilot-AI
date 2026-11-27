import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { projects, serverProjects, server } = vi.hoisted(() => {
	const answer = () => vi.fn(async (..._args: unknown[]) => ({ success: true, data: [] }));
	return {
		projects: new Map<string, { id: string; path: string; autoBuildPath?: string }>(),
		serverProjects: new Set<string>(),
		server: {
			listServerSprints: answer(),
			saveServerSprint: answer(),
			startServerSprint: answer(),
			completeServerSprint: answer(),
			deleteServerSprint: answer(),
		},
	};
});

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../project-store", () => ({ projectStore: { getProject: (id: string) => projects.get(id) } }));
vi.mock("../../server-projects", () => ({ getServerProject: (id: string) => (serverProjects.has(id) ? { id } : undefined) }));
vi.mock("../../sprints/server-sprints", () => server);

import {
	handleCompleteSprint,
	handleDeleteSprint,
	handleListSprints,
	handleSaveSprint,
	handleStartSprint,
} from "../sprint-handlers";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "sprints-"));
	mkdirSync(path.join(root, "project"));
	projects.set("local-1", { id: "local-1", path: path.join(root, "project") });
	serverProjects.add("srv-1");
});

afterEach(() => {
	projects.clear();
	serverProjects.clear();
	vi.clearAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function stored(): { sprints: { id: string; state: string }[] } {
	return JSON.parse(readFileSync(path.join(root, "project", ".workpilot", "sprints.json"), "utf-8"));
}

describe("sprint handlers", () => {
	it("keeps a local project's sprints in its .workpilot folder", async () => {
		const saved = await handleSaveSprint("local-1", { name: "S1" });
		expect(saved.success).toBe(true);
		const id = saved.data?.[0].id as string;
		expect(stored().sprints[0]).toMatchObject({ id, state: "planned" });

		expect((await handleStartSprint("local-1", id, { cards: 2, points: 5 })).data?.[0].state).toBe("active");
		const report = { done: 2, donePoints: 5, carried: 0, carriedPoints: 0, carriedTo: null };
		expect((await handleCompleteSprint("local-1", id, report)).data?.[0].state).toBe("closed");
		expect(await handleDeleteSprint("local-1", id)).toEqual({ success: false, error: "not_planned" });
		expect((await handleListSprints("local-1")).data).toHaveLength(1);
	});

	it("sends a server project's sprints to the server, checked first", async () => {
		await handleSaveSprint("srv-1", { name: " S " });
		expect(server.saveServerSprint).toHaveBeenCalledWith("srv-1", { name: "S" });
		await handleStartSprint("srv-1", "sp-0000000a", { cards: 1, points: 1 });
		expect(server.startServerSprint).toHaveBeenCalledWith("srv-1", "sp-0000000a", { cards: 1, points: 1 });
		await handleListSprints("srv-1");
		expect(server.listServerSprints).toHaveBeenCalledWith("srv-1");
	});

	it("refuses an unknown project, a bad draft, id, commitment or report before anything is written", async () => {
		expect(await handleListSprints(42)).toEqual({ success: false, error: "Invalid project id" });
		expect(await handleListSprints("nope")).toEqual({ success: false, error: "Unknown project" });
		expect(await handleSaveSprint("srv-1", { name: "two\nlines" })).toEqual({ success: false, error: "invalid" });
		expect(await handleStartSprint("srv-1", "../x", { cards: 1, points: 1 })).toEqual({ success: false, error: "invalid" });
		expect(await handleStartSprint("srv-1", "sp-0000000a", { cards: -1, points: 1 })).toEqual({ success: false, error: "invalid" });
		expect(await handleCompleteSprint("srv-1", "sp-0000000a", { done: "all" })).toEqual({ success: false, error: "invalid" });
		expect(await handleDeleteSprint("srv-1", "sp-x")).toEqual({ success: false, error: "invalid" });
		expect(server.saveServerSprint).not.toHaveBeenCalled();
		expect(server.startServerSprint).not.toHaveBeenCalled();
		expect(server.deleteServerSprint).not.toHaveBeenCalled();
	});

	it("does not follow a .workpilot folder or a temporary file that leads out of the project", async () => {
		const outside = path.join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, path.join(root, "project", ".workpilot"), "junction");
		expect(await handleSaveSprint("local-1", { name: "S" })).toEqual({ success: false, error: "write_failed" });
		expect(existsSync(path.join(outside, "sprints.json"))).toBe(false);

		rmSync(path.join(root, "project", ".workpilot"));
		mkdirSync(path.join(root, "project", ".workpilot"));
		const target = path.join(outside, "keep.txt");
		writeFileSync(target, "keep");
		symlinkSync(target, path.join(root, "project", ".workpilot", `sprints.json.${process.pid}.tmp`));
		expect((await handleSaveSprint("local-1", { name: "S" })).success).toBe(true);
		expect(readFileSync(target, "utf-8")).toBe("keep");
	});
});
