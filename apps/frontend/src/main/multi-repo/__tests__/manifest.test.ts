import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../../../shared/types";
import {
	createOrchestration,
	listOrchestrationIds,
	MANIFEST_FILE,
	orchestrationDir,
	orchestrationsRoot,
	parseManifest,
	readManifest,
	toOrchestration,
} from "../manifest";

let root: string;
let project: Project;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "multi-repo-manifest-"));
	project = {
		id: "host",
		name: "host",
		path: root,
		autoBuildPath: ".workpilot",
		settings: {} as Project["settings"],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const repos = [
	{ name: "api", path: "/r/api", projectId: "p-api" },
	{ name: "web", path: "/r/web", projectId: "p-web" },
];

describe("orchestration directories", () => {
	it("live outside the specs directory, so they are never a card", () => {
		const id = createOrchestration(project, repos, "Add auth");
		expect(id).toBe("001-add-auth");
		expect(orchestrationsRoot(project)).toBe(path.join(root, ".workpilot", "multi-repo"));
		expect(orchestrationDir(project, id)).toBe(
			path.join(root, ".workpilot", "multi-repo", id),
		);
	});

	it("number the next one after the highest", () => {
		createOrchestration(project, repos, "One");
		const second = createOrchestration(project, repos, "Ünïcode two!");
		expect(second).toBe("002-unicode-two");
		expect(listOrchestrationIds(project)).toEqual(["001-one", "002-unicode-two"]);
	});

	it.each([["../etc"], ["001-../x"], ["1-short"], ["001-UPPER"], [42], [null]])(
		"refuse the id %s",
		(id) => {
			expect(orchestrationDir(project, id)).toBeNull();
		},
	);

	it("list only directories that hold a manifest", () => {
		createOrchestration(project, repos, "Real");
		mkdirSync(path.join(orchestrationsRoot(project), "002-empty"));
		expect(listOrchestrationIds(project)).toEqual(["001-real"]);
	});
});

describe("parseManifest", () => {
	it("types every field and falls back on what it does not know", () => {
		const m = parseManifest({
			task_description: 3,
			repos: [{ repo: "a", status: "exploding", progress: 250 }, "junk"],
			status: "teleporting",
			breaking_changes: [{ severity: "fatal" }],
		});
		expect(m.task_description).toBe("");
		expect(m.repos[0]).toMatchObject({ repo: "a", status: "pending", progress: 100 });
		expect(m.repos[1]).toMatchObject({ repo: "", status: "pending", progress: 0 });
		expect(m.status).toBe("pending");
		expect(m.breaking_changes[0].severity).toBe("warning");
		expect(m.dependency_graph).toEqual({ repos: [], dependencies: [] });
	});

	it("reads nothing from a broken file", () => {
		const id = createOrchestration(project, repos, "Broken");
		const dir = orchestrationDir(project, id) as string;
		writeFileSync(path.join(dir, MANIFEST_FILE), "{not json", "utf-8");
		expect(readManifest(dir)).toBeNull();
	});
});

describe("toOrchestration", () => {
	it("is what the renderer sees, progress averaged", () => {
		const id = createOrchestration(project, repos, "Add auth");
		const m = readManifest(orchestrationDir(project, id) as string);
		expect(m).not.toBeNull();
		if (!m) return;
		m.repos[0].progress = 100;
		m.repos[0].status = "completed";
		m.repos[0].task_id = "001-api-add-auth";
		m.status_message = "status.waitingOnRepo";
		m.status_repo = "web";
		const o = toOrchestration(id, "host", m, true);
		expect(o).toMatchObject({
			id,
			projectId: "host",
			running: true,
			overallProgress: 50,
			statusKey: "status.waitingOnRepo",
			statusRepo: "web",
		});
		expect(o.repoStates[0]).toMatchObject({
			repo: "api",
			status: "completed",
			taskId: "001-api-add-auth",
			projectId: "p-api",
		});
		expect(o.repoStates[1].taskId).toBeUndefined();
	});
});
