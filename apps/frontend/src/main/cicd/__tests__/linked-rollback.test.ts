/**
 * @vitest-environment node
 *
 * The coordinated rollback of linked services (#366, lot 4): each linked
 * project is rolled back with its own runner call, in order, and what became
 * of each is recorded next to the failed run's watch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../../../shared/types";
import {
	type LinkedRunner,
	linkedResult,
	linkedRollbacksPath,
	readLinkedRollbacks,
	rollBackLinked,
} from "../linked-rollback";

const RUN = "1763200000000";
const SINCE = "2026-11-15T08:00:00+00:00";

function project(dir: string, id: string, name = id): Project {
	return { id, name, path: path.join(dir, id), autoBuildPath: ".workpilot" } as Project;
}

describe("rollBackLinked", () => {
	let dir: string;
	let root: Project;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "linked-rollback-"));
		root = project(dir, "api", "Shop API");
		mkdirSync(root.path);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("rolls each linked project back with its own call, nearest first", async () => {
		const web = project(dir, "web", "Shop web");
		const worker = project(dir, "worker");
		const calls: Array<{ project: string; args: string[] }> = [];
		const run: LinkedRunner = async (p, args) => {
			calls.push({ project: p.id, args });
			if (p.id === "web") {
				return {
					success: true,
					data: {
						status: "manual",
						run_id: "1763100000000",
						plan: { target_url: "https://gitlab.com/acme/web/-/pipelines/7" },
						migrations: ["db/1.sql"],
					},
				};
			}
			return { success: false, error: "boom" };
		};
		const projects = new Map([
			["web", web],
			["worker", worker],
			["self", { ...root, id: "self" }],
		]);
		const results = await rollBackLinked({
			root,
			runId: RUN,
			since: SINCE,
			order: ["web", "gone", "self", "worker"],
			findProject: (id) => projects.get(id),
			run,
		});
		expect(calls).toEqual([
			{
				project: "web",
				args: ["--action", "rollback-linked", "--project", web.path, "--since", SINCE, "--cause", "Shop API"],
			},
			{ project: "worker", args: expect.arrayContaining(["--project", worker.path]) },
		]);
		expect(results.map((r) => [r.projectId, r.name, r.status])).toEqual([
			["web", "Shop web", "manual"],
			["gone", "", "missing"],
			["self", "", "missing"],
			["worker", "worker", "error"],
		]);
		expect(results[0]).toMatchObject({
			runId: "1763100000000",
			targetUrl: "https://gitlab.com/acme/web/-/pipelines/7",
			migrations: ["db/1.sql"],
		});
		expect(readLinkedRollbacks(root.path, RUN)).toEqual(results);
	});

	it("does nothing without a run id, a moment or a link", async () => {
		const run: LinkedRunner = async () => {
			throw new Error("must not run");
		};
		const base = { root, findProject: () => undefined, run };
		expect(await rollBackLinked({ ...base, runId: "../x", since: SINCE, order: ["web"] })).toEqual([]);
		expect(await rollBackLinked({ ...base, runId: RUN, since: "yesterday", order: ["web"] })).toEqual([]);
		expect(await rollBackLinked({ ...base, runId: RUN, since: SINCE, order: [] })).toEqual([]);
		expect(readLinkedRollbacks(root.path, RUN)).toBeUndefined();
	});

	it("survives a runner that throws and a record it cannot write", async () => {
		const web = project(dir, "web");
		// The watch folder is a file: the record cannot be written.
		mkdirSync(path.join(root.path, ".workpilot"));
		writeFileSync(path.join(root.path, ".workpilot", "deploy_watches"), "", "utf-8");
		const results = await rollBackLinked({
			root,
			runId: RUN,
			since: SINCE,
			order: ["web"],
			findProject: () => web,
			run: async () => {
				throw new Error("spawn failed");
			},
		});
		expect(results.map((r) => r.status)).toEqual(["error"]);
	});
});

describe("reading the record", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "linked-read-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("types and bounds what it finds", () => {
		expect(readLinkedRollbacks(dir, "../x")).toBeUndefined();
		const file = linkedRollbacksPath(dir, RUN);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ not: "a list" }), "utf-8");
		expect(readLinkedRollbacks(dir, RUN)).toBeUndefined();
		writeFileSync(
			file,
			JSON.stringify([
				{ projectId: "web", name: "Web", status: "rm -rf", runId: "abc", targetUrl: "javascript:x", migrations: "x" },
				"junk",
			]),
			"utf-8",
		);
		expect(readLinkedRollbacks(dir, RUN)).toEqual([
			{ projectId: "web", name: "Web", status: "error", runId: "", targetUrl: "", migrations: [] },
			{ projectId: "", name: "", status: "error", runId: "", targetUrl: "", migrations: [] },
		]);
	});

	it("keeps an https link without spaces only", () => {
		expect(linkedResult({ status: "started", targetUrl: "https://a.example/x y" }).targetUrl).toBe("");
		expect(linkedResult({ status: "started", targetUrl: "https://a.example/x" }).targetUrl).toBe(
			"https://a.example/x",
		);
	});
});
