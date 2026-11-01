/**
 * Server mode in the app: the server's projects next to this computer's, and
 * a server project's board drawn from the server's snapshot.
 *
 * What the server sends is checked again here: a project id that is not one,
 * a card id outside the board's pattern, a file the app does not read, or one
 * over its limit never reaches the disk.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let TEST_DIR: string;

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => path.join(TEST_DIR, "userData")) },
}));

const connection = vi.hoisted(() => ({
	serverMode: true,
	authedFetch: vi.fn(),
}));

vi.mock("../server-connection", () => ({
	authedFetch: connection.authedFetch,
	getServerUrl: () => (connection.serverMode ? "https://wp.example" : null),
	isServerMode: () => connection.serverMode,
}));

const PROJECT_ID = "6f1c2b9e-0d4a-4c1e-9a7b-1f2e3d4c5b6a";

function serverProject(overrides: Record<string, unknown> = {}) {
	return {
		id: PROJECT_ID,
		org_id: "org-1",
		name: "Shop",
		repo_url: "https://git.example/shop.git",
		default_branch: "develop",
		created_by: "u-1",
		created_at: "2026-10-31T10:00:00Z",
		my_role: "member",
		...overrides,
	};
}

beforeEach(() => {
	TEST_DIR = mkdtempSync(path.join(tmpdir(), "server-board-test-"));
	mkdirSync(path.join(TEST_DIR, "userData", "store"), { recursive: true });
	connection.serverMode = true;
	connection.authedFetch.mockReset();
	vi.resetModules();
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("server projects", () => {
	it("lists the server's projects as read-only mirrors, never as paths it was sent", async () => {
		connection.authedFetch.mockResolvedValue({
			ok: true,
			data: [
				serverProject({ forge: "gitlab" }),
				serverProject({ id: "../../etc", name: "Escape" }),
				serverProject({ id: "b2", name: "", my_role: null }),
				serverProject({ id: "c3", name: "Admin view", my_role: null, forge: "bitbucket" }),
			],
		});
		const { listServerProjects, getServerProject, serverProjectAtPath } = await import(
			"../server-projects"
		);

		const projects = await listServerProjects();
		// A view naming its project by folder finds a server project by its mirror only.
		expect(serverProjectAtPath(projects[0].path)?.id).toBe(PROJECT_ID);
		expect(serverProjectAtPath(`${projects[0].path}/../${PROJECT_ID}`)?.id).toBe(PROJECT_ID);
		expect(serverProjectAtPath(path.join(TEST_DIR, "elsewhere"))).toBeUndefined();
		expect(serverProjectAtPath("")).toBeUndefined();
		expect(serverProjectAtPath(42)).toBeUndefined();

		expect(projects.map((p) => p.name)).toEqual(["Shop", "Admin view"]);
		const shop = projects[0];
		expect(shop.remote).toEqual({
			repoUrl: "https://git.example/shop.git",
			defaultBranch: "develop",
			role: "member",
			forge: "gitlab",
		});
		// The forge is the server's to say; an unknown value is none.
		expect(projects[1].remote?.forge).toBeUndefined();
		expect(shop.path.startsWith(path.join(TEST_DIR, "userData", "server-boards"))).toBe(true);
		expect(shop.path.endsWith(PROJECT_ID)).toBe(true);
		// No role on the project: shown as a viewer, the server decides the rest.
		expect(projects[1].remote?.role).toBe("viewer");
		expect(getServerProject(PROJECT_ID)?.name).toBe("Shop");
		expect(getServerProject("../../etc")).toBeUndefined();
	});

	it("lists nothing in local mode and forgets the server's projects", async () => {
		connection.authedFetch.mockResolvedValue({ ok: true, data: [serverProject()] });
		const { listServerProjects, getServerProject } = await import(
			"../server-projects"
		);
		await listServerProjects();
		connection.serverMode = false;

		expect(await listServerProjects()).toEqual([]);
		expect(getServerProject(PROJECT_ID)).toBeUndefined();
	});

	it("creates a project from a repository URL and refuses malformed input before asking", async () => {
		connection.authedFetch.mockResolvedValue({ ok: true, data: serverProject() });
		const { createServerProject } = await import("../server-projects");

		for (const bad of [
			null,
			{ name: "", repoUrl: "https://x/y.git" },
			{ name: "A", repoUrl: "" },
			{ name: "A", repoUrl: "https://x/y.git --upload-pack=evil" },
			{ name: "A", repoUrl: "https://x/y.git", defaultBranch: "main dev" },
		]) {
			expect((await createServerProject(bad)).success).toBe(false);
		}
		expect(connection.authedFetch).not.toHaveBeenCalled();

		const result = await createServerProject({
			name: " Shop ",
			repoUrl: " https://git.example/shop.git ",
		});
		expect(result.data?.id).toBe(PROJECT_ID);
		expect(connection.authedFetch).toHaveBeenCalledWith("/projects", "POST", {
			name: "Shop",
			repo_url: "https://git.example/shop.git",
			default_branch: "main",
		});
	});

	it("deletes only a project it listed, and drops its mirror", async () => {
		connection.authedFetch.mockResolvedValue({ ok: true, data: [serverProject()] });
		const { deleteServerProject, listServerProjects } = await import(
			"../server-projects"
		);
		const [project] = await listServerProjects();
		mkdirSync(project.path, { recursive: true });
		connection.authedFetch.mockClear();

		expect((await deleteServerProject("unknown")).success).toBe(false);
		expect(connection.authedFetch).not.toHaveBeenCalled();

		connection.authedFetch.mockResolvedValue({ ok: true, data: { deleted: true } });
		expect((await deleteServerProject(PROJECT_ID)).success).toBe(true);
		expect(connection.authedFetch).toHaveBeenCalledWith(
			`/projects/${PROJECT_ID}`,
			"DELETE",
		);
		expect(existsSync(project.path)).toBe(false);
	});
});

describe("remote board", () => {
	it("keeps only the card ids and files the app reads, within their limits", async () => {
		const { parseSnapshot, SNAPSHOT_FILES } = await import("../remote-board");
		const big = "x".repeat((SNAPSHOT_FILES.get("spec.md") ?? 0) + 1);
		const snapshot = parseSnapshot(
			JSON.parse(
				JSON.stringify({
					cards: {
						"001-login": {
							"spec.md": "# Login",
							"task_metadata.json": "{}",
							"agent.log": "not read",
							"../escape.md": "no",
						},
						"002-big": { "spec.md": big },
						"../../etc": { "spec.md": "no" },
						"003-weird": { "spec.md": 42 },
					},
					worktrees: {
						"001-login": { "implementation_plan.json": "{}" },
						"999-unknown": { "spec.md": "no" },
						constructor: { "spec.md": "no" },
					},
				}),
			),
		);

		expect(snapshot).toEqual({
			cards: {
				"001-login": { "spec.md": "# Login", "task_metadata.json": "{}" },
				"002-big": {},
				"003-weird": {},
			},
			worktrees: { "001-login": { "implementation_plan.json": "{}" } },
		});
		expect(parseSnapshot(null)).toBeNull();
		expect(parseSnapshot({ cards: [] })).toBeNull();
	});

	it("draws the server's cards like local ones and forgets cards the server dropped", async () => {
		connection.authedFetch.mockResolvedValue({ ok: true, data: [serverProject()] });
		const { listServerProjects } = await import("../server-projects");
		const { getRemoteTasks } = await import("../remote-board");
		const [project] = await listServerProjects();
		const requirements = JSON.stringify({ task_description: "Users sign in." });
		const metadata = JSON.stringify({ sourceType: "server" });

		connection.authedFetch.mockResolvedValue({
			ok: true,
			data: {
				cards: {
					"001-login": {
						"requirements.json": requirements,
						"task_metadata.json": metadata,
					},
					"002-logout": {
						"requirements.json": requirements,
						"task_metadata.json": metadata,
					},
				},
				worktrees: {},
			},
		});
		const first = await getRemoteTasks(project);
		expect(connection.authedFetch).toHaveBeenLastCalledWith(
			`/api/board/snapshot?project_id=${PROJECT_ID}`,
			"GET",
		);
		expect(first.data?.map((t) => t.specId).sort()).toEqual([
			"001-login",
			"002-logout",
		]);
		expect(first.data?.[0]?.projectId).toBe(PROJECT_ID);

		connection.authedFetch.mockResolvedValue({
			ok: true,
			data: { cards: { "002-logout": { "requirements.json": requirements } } },
		});
		const second = await getRemoteTasks(project);
		expect(second.data?.map((t) => t.specId)).toEqual([
			"002-logout",
		]);
		expect(readdirSync(path.join(project.path, ".workpilot", "specs"))).toEqual([
			"002-logout",
		]);
		expect(
			readFileSync(
				path.join(project.path, ".workpilot/specs/002-logout/requirements.json"),
				"utf-8",
			),
		).toBe(requirements);
	});

	it("reports the server's refusal and leaves the local store alone", async () => {
		connection.authedFetch.mockResolvedValue({ ok: true, data: [serverProject()] });
		const { listServerProjects } = await import("../server-projects");
		const { getRemoteTasks } = await import("../remote-board");
		const { projectStore } = await import("../project-store");
		const [project] = await listServerProjects();

		connection.authedFetch.mockResolvedValue({ ok: false, error: "Project not found" });
		expect(await getRemoteTasks(project)).toEqual({
			success: false,
			error: "Project not found",
		});
		expect(projectStore.getProject(PROJECT_ID)).toBeUndefined();
	});
});
