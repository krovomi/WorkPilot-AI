/**
 * @vitest-environment node
 *
 * The multi-repo handlers trust nothing the renderer sends: a repository is a
 * registered project or a folder the user picked in a dialog, an
 * orchestration id matches its pattern, a server project is refused.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	projects: [] as Array<{
		id: string;
		name: string;
		path: string;
		autoBuildPath: string;
		remote?: object;
	}>,
	started: [] as string[],
	ensureFails: false,
}));

vi.mock("electron", () => ({
	app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
	ipcMain: {
		handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler),
		on: vi.fn(),
	},
}));

vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => state.projects.find((p) => p.id === id),
		getProjects: () => state.projects,
	},
}));

vi.mock("../../multi-repo/host", () => ({
	createMultiRepoHost: () => ({}),
	ensureRepoProject: (repoPath: string) => {
		if (state.ensureFails) return null;
		const known = state.projects.find((p) => p.path === repoPath);
		if (known) return known;
		const added = {
			id: `p-${path.basename(repoPath)}`,
			name: path.basename(repoPath),
			path: repoPath,
			autoBuildPath: ".workpilot",
		};
		state.projects.push(added);
		return added;
	},
}));

vi.mock("../../multi-repo/service", () => ({
	isMultiRepoRunning: () => false,
	startMultiRepoRun: (dir: string) => {
		state.started.push(dir);
		return true;
	},
	stopMultiRepoRun: () => true,
}));

import { rememberUserChosenPath, forgetUserChosenPaths } from "../../security/renderer-path";
import { registerMultiRepoHandlers } from "../multi-repo-handlers";

let base: string;
let host: string;
let api: string;
let picked: string;
let outside: string;

function call(channel: string, ...args: unknown[]) {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({}, ...args) as Promise<{ success: boolean; error?: string; data?: unknown }>;
}

beforeAll(() => {
	base = realpathSync(mkdtempSync(path.join(tmpdir(), "multi-repo-handlers-")));
	for (const name of ["host", "api", "picked", "outside"]) mkdirSync(path.join(base, name));
	host = path.join(base, "host");
	api = path.join(base, "api");
	picked = path.join(base, "picked");
	outside = path.join(base, "outside");
	mkdirSync(path.join(api, "sub"));
	registerMultiRepoHandlers(() => null);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

beforeEach(() => {
	state.projects = [
		{ id: "host", name: "host", path: host, autoBuildPath: ".workpilot" },
		{ id: "api", name: "api: core", path: api, autoBuildPath: ".workpilot" },
		{ id: "srv", name: "srv", path: host, autoBuildPath: "", remote: {} },
	];
	state.started = [];
	state.ensureFails = false;
	forgetUserChosenPaths();
});

const create = (repos: unknown, taskDescription: unknown = "Add auth", projectId = "host") =>
	call(IPC_CHANNELS.MULTI_REPO_CREATE, projectId, { repos, taskDescription });

describe("MULTI_REPO_CREATE", () => {
	it("takes registered projects and folders picked in a dialog", async () => {
		rememberUserChosenPath(picked);
		const result = await create([{ localPath: api }, { localPath: picked }]);
		expect(result.success).toBe(true);
		const data = result.data as { id: string; repos: Array<{ repo: string; localPath: string }> };
		expect(data.id).toBe("001-add-auth");
		// "api: core" becomes a name the runner's name::path list can carry.
		expect(data.repos.map((r) => r.repo)).toEqual(["api- core", "picked"]);
		expect(data.repos[1].localPath).toBe(picked);
	});

	it.each([
		["a path never picked nor registered", () => [{ localPath: api }, { localPath: outside }]],
		["a relative path", () => [{ localPath: api }, { localPath: "picked" }]],
		["a folder inside a project", () => [{ localPath: api }, { localPath: path.join(api, "sub") }]],
		["a way out of a picked folder", () => [{ localPath: api }, { localPath: path.join(api, "..", "outside") }]],
		["a non-string path", () => [{ localPath: api }, { localPath: 7 }]],
	])("refuses %s", async (_label, repos) => {
		const result = await create(repos());
		expect(result).toEqual({ success: false, error: "errors.repoNotAllowed" });
	});

	it("refuses one repo, the same repo twice, and too many", async () => {
		expect((await create([{ localPath: api }])).error).toBe("errors.noRepos");
		expect((await create("nope")).error).toBe("errors.noRepos");
		expect((await create([{ localPath: api }, { localPath: `${api}/` }])).error).toBe(
			"errors.duplicateRepo",
		);
		const many = Array.from({ length: 9 }, () => ({ localPath: api }));
		expect((await create(many)).error).toBe("errors.tooManyRepos");
	});

	it("refuses a repo that cannot become a project", async () => {
		rememberUserChosenPath(picked);
		state.ensureFails = true;
		expect((await create([{ localPath: api }, { localPath: picked }])).error).toBe(
			"errors.repoNotUsable",
		);
	});

	it("refuses an empty or oversized description", async () => {
		rememberUserChosenPath(picked);
		const repos = [{ localPath: api }, { localPath: picked }];
		expect((await create(repos, "  ")).error).toBe("errors.noDescription");
		expect((await create(repos, "x".repeat(20_001))).error).toBe("errors.descriptionTooLong");
	});

	it("keeps the engine chosen for the repositories' tasks, and refuses a malformed one", async () => {
		rememberUserChosenPath(picked);
		const repos = [{ localPath: api }, { localPath: picked }];
		const trio = { provider: "openai", model: "gpt-5.5-codex", effort: "high" };
		const engine = { spec: trio, planning: trio, coding: trio, qa: trio };

		const created = await call(IPC_CHANNELS.MULTI_REPO_CREATE, "host", {
			repos,
			taskDescription: "Add auth",
			engine,
		});
		expect(created.success).toBe(true);
		expect((created.data as { engine?: unknown }).engine).toEqual(engine);
		const listed = await call(IPC_CHANNELS.MULTI_REPO_LIST, "host");
		expect((listed.data as Array<{ engine?: unknown }>)[0].engine).toEqual(engine);

		for (const bad of [
			"openai",
			{ ...engine, qa: { ...trio, provider: "Open AI" } },
			{ ...engine, coding: { ...trio, model: "gpt\nINJECTED=1" } },
			{ ...engine, planning: { ...trio, effort: "maximum" } },
			{ spec: trio, coding: trio },
		]) {
			expect(
				await call(IPC_CHANNELS.MULTI_REPO_CREATE, "host", {
					repos,
					taskDescription: "Add auth",
					engine: bad,
				}),
			).toEqual({ success: false, error: "errors.invalidEngine" });
		}
	});

	it("leaves the engine to each project when none is chosen", async () => {
		rememberUserChosenPath(picked);
		const created = await create([{ localPath: api }, { localPath: picked }]);
		expect(created.success).toBe(true);
		expect((created.data as { engine?: unknown }).engine).toBeUndefined();
	});

	it("refuses a server project and an unknown one", async () => {
		const repos = [{ localPath: api }, { localPath: host }];
		expect((await create(repos, "t", "srv")).error).toBe("errors.projectNotFound");
		expect((await create(repos, "t", "ghost")).error).toBe("errors.projectNotFound");
	});
});

describe("MULTI_REPO_START / GET", () => {
	it("starts an orchestration it knows, by id only", async () => {
		rememberUserChosenPath(picked);
		const created = await create([{ localPath: api }, { localPath: picked }], "Start me");
		const id = (created.data as { id: string }).id;

		expect(await call(IPC_CHANNELS.MULTI_REPO_START, "host", id)).toEqual({ success: true });
		expect(state.started).toEqual([path.join(host, ".workpilot", "multi-repo", id)]);

		for (const bad of ["../../etc", "001-missing", 1]) {
			expect(await call(IPC_CHANNELS.MULTI_REPO_START, "host", bad)).toEqual({
				success: false,
				error: "errors.notFound",
			});
		}
		expect((await call(IPC_CHANNELS.MULTI_REPO_GET, "host", "../x")).data).toBeNull();
		const listed = await call(IPC_CHANNELS.MULTI_REPO_LIST, "host");
		expect((listed.data as Array<{ id: string }>).map((o) => o.id)).toContain(id);
	});
});
