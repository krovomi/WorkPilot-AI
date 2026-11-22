/**
 * A task created from the board must carry the same paths as one the project
 * store loads from disk: the task detail reads `specsPath` (the "Fichiers"
 * tab, the spec cards) from the object the creation returned, until the next
 * full reload of the board.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types";
import { createLocalTask } from "../create-local-task";

const invalidate = vi.hoisted(() => vi.fn());
vi.mock("../../../project-store", () => ({
	projectStore: { invalidateTasksCache: invalidate },
}));

const PNG = Buffer.from("png-bytes").toString("base64");
const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

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
	it("numbers the spec after the highest existing folder, ignoring files", () => {
		const specs = path.join(root, ".workpilot", "specs");
		mkdirSync(path.join(specs, "001-a"), { recursive: true });
		mkdirSync(path.join(specs, "007-b"));
		mkdirSync(path.join(specs, "notes"));
		writeFileSync(path.join(specs, "042-not-a-spec.txt"), "");

		const task = createLocalTask(project, {
			title: "Next one",
			aiDescription: "d",
			displayDescription: "d",
			descriptionIsHtml: false,
		});

		expect(task.specId).toMatch(/^008-/);
		expect(task.status).toBe("backlog");
		expect(invalidate).toHaveBeenCalledWith("proj-1");
	});

	it("starts the task's status history: a person's card, or the app's", () => {
		const byHand = createLocalTask(project, {
			title: "By hand",
			aiDescription: "d",
			displayDescription: "d",
			descriptionIsHtml: false,
		});
		const generated = createLocalTask(project, {
			title: "Generated",
			aiDescription: "d",
			displayDescription: "d",
			descriptionIsHtml: false,
			createdBy: "system",
		});
		const history = (task: { specsPath?: string }) =>
			read(path.join(task.specsPath as string, "status_history.json")).entries;
		expect(history(byHand)).toEqual([
			expect.objectContaining({ from: null, to: "backlog", actor: "user" }),
		]);
		expect(history(generated)[0].actor).toBe("system");
	});

	it("writes the plan, the metadata and the requirements the pipeline reads", () => {
		const task = createLocalTask(project, {
			title: "Rich",
			aiDescription: "plain text",
			displayDescription: "<p>plain <b>text</b></p>",
			descriptionIsHtml: true,
			metadata: {
				category: "bug_fix",
				acceptanceCriteria: ["it works"],
				extraNote: "  look at the logs  ",
			} as never,
		});
		const dir = task.specsPath as string;

		expect(read(path.join(dir, "implementation_plan.json"))).toMatchObject({
			feature: "Rich",
			description: "plain text",
			status: "pending",
			phases: [],
		});
		expect(read(path.join(dir, "task_metadata.json"))).toMatchObject({
			sourceType: "manual",
			category: "bug_fix",
		});
		expect(read(path.join(dir, "requirements.json"))).toEqual({
			task_description: "plain text",
			workflow_type: "bug_fix",
			display_description: "<p>plain <b>text</b></p>",
			acceptance_criteria: ["it works"],
			additional_context: "look at the logs",
		});
	});

	it("keeps the requirements to the description when nothing else is given", () => {
		const task = createLocalTask(project, {
			title: "Bare",
			aiDescription: "same",
			displayDescription: "same",
			descriptionIsHtml: true,
			metadata: { acceptanceCriteria: [], extraNote: "   " } as never,
		});

		expect(read(path.join(task.specsPath as string, "requirements.json"))).toEqual({
			task_description: "same",
			workflow_type: "feature",
		});
		expect(task.metadata).toMatchObject({ sourceType: "manual" });
	});

	it("saves only allowed images, by their base name, inside the attachments folder", () => {
		const image = (over: Record<string, unknown>) => ({
			id: String(over.filename),
			mimeType: "image/png",
			size: 9,
			data: PNG,
			...over,
		});
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const task = createLocalTask(project, {
			title: "Images",
			aiDescription: "d",
			displayDescription: "d",
			descriptionIsHtml: false,
			metadata: {
				attachedImages: [
					image({ filename: "shot.png" }),
					image({ filename: "../../escape.png" }),
					image({ filename: "page.html", mimeType: "text/html" }),
					image({ filename: "nomime.png", mimeType: undefined }),
					image({ filename: ".." }),
					image({ filename: "" }),
					image({ filename: "nodata.png", data: undefined }),
					image({ filename: `${"x".repeat(300)}.png` }),
				],
			} as never,
		});
		const dir = task.specsPath as string;

		expect(readdirSync(path.join(dir, "attachments")).sort()).toEqual(["escape.png", "shot.png"]);
		expect(readFileSync(path.join(dir, "attachments", "shot.png"), "utf-8")).toBe("png-bytes");
		expect(existsSync(path.join(root, ".workpilot", "escape.png"))).toBe(false);
		const saved = [
			{ id: "shot.png", filename: "shot.png", mimeType: "image/png", size: 9, path: "attachments/shot.png" },
			{
				id: "../../escape.png",
				filename: "escape.png",
				mimeType: "image/png",
				size: 9,
				path: "attachments/escape.png",
			},
		];
		expect(read(path.join(dir, "task_metadata.json")).attachedImages).toEqual(saved);
		expect(read(path.join(dir, "requirements.json")).attached_images).toEqual([
			{ filename: "shot.png", path: "attachments/shot.png", description: "" },
			{ filename: "escape.png", path: "attachments/escape.png", description: "" },
		]);
		// The name too long for the disk is reported, not thrown.
		expect(console.error).toHaveBeenCalledTimes(1);
	});
});
