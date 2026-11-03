/**
 * A task created from the board must carry the same paths as one the project
 * store loads from disk: the task detail reads `specsPath` (the "Fichiers"
 * tab, the spec cards) from the object the creation returned, until the next
 * full reload of the board.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";
import { createLocalTask } from "../create-local-task";

vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: vi.fn() },
}));

describe("createLocalTask", () => {
	let root: string;
	let project: Project;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "create-local-task-"));
		project = {
			id: "proj-1",
			name: "Test",
			path: root,
			autoBuildPath: ".workpilot",
		} as unknown as Project;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns the spec folder it created and the main location", () => {
		const task = createLocalTask(project, {
			title: "Créer un fichier test.txt",
			aiDescription: 'Créer un fichier test.txt et mettre "OK" dedans',
			displayDescription: 'Créer un fichier test.txt et mettre "OK" dedans',
			descriptionIsHtml: false,
		});

		expect(task.location).toBe("main");
		expect(task.specsPath).toBe(
			path.join(root, ".workpilot", "specs", task.specId),
		);
		expect(existsSync(task.specsPath as string)).toBe(true);
	});
});
