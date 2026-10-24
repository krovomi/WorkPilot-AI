import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const projects = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../project-store", () => ({
	projectStore: {
		getProjects: () => projects.paths.map((p) => ({ path: p })),
	},
}));

import {
	forgetUserChosenPaths,
	isAddableProject,
	isWithinRoot,
	rememberUserChosenPath,
	resolveInProject,
	resolveKnownProject,
	resolveUnder,
	resolveWithinRoots,
} from "./renderer-path";

let base: string;
let project: string;
let sibling: string;
let outside: string;

beforeAll(() => {
	base = realpathSync(mkdtempSync(path.join(tmpdir(), "renderer-path-")));
	project = path.join(base, "repo");
	sibling = path.join(base, "repo-other");
	outside = path.join(base, "outside");
	for (const dir of [project, sibling, outside, path.join(project, "sub")]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(project, "sub", "shot.png"), "png");
	writeFileSync(path.join(sibling, "secret.txt"), "sibling");
	writeFileSync(path.join(outside, "id_rsa"), "key");
	// A junction needs no privilege on Windows; elsewhere the type is ignored.
	symlinkSync(outside, path.join(project, "link"), "junction");
	projects.paths = [project];
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("isWithinRoot", () => {
	it("accepts the root and what is below it", () => {
		expect(isWithinRoot("/repo", "/repo")).toBe(true);
		expect(isWithinRoot("/repo/a/b", "/repo")).toBe(true);
		expect(isWithinRoot("/repo/..hidden", "/repo")).toBe(true);
	});

	it("refuses a parent and a sibling that shares the prefix", () => {
		expect(isWithinRoot("/", "/repo")).toBe(false);
		expect(isWithinRoot("/repo-other/x", "/repo")).toBe(false);
	});
});

describe("resolveInProject", () => {
	it("serves a file inside a known project", () => {
		const shot = path.join(project, "sub", "shot.png");
		expect(resolveInProject(shot, "file")).toBe(shot);
	});

	it("refuses a file outside every project", () => {
		expect(resolveInProject(path.join(outside, "id_rsa"))).toBeNull();
	});

	it("refuses a sibling folder that shares the project's prefix", () => {
		expect(resolveInProject(path.join(sibling, "secret.txt"))).toBeNull();
	});

	it("refuses a symlink in the project that points outside it", () => {
		expect(resolveInProject(path.join(project, "link", "id_rsa"))).toBeNull();
	});

	it("refuses a path that climbs out with ..", () => {
		expect(
			resolveInProject(path.join(project, "..", "outside", "id_rsa")),
		).toBeNull();
	});

	it("refuses relative paths, non-strings and missing files", () => {
		expect(resolveInProject("repo/sub/shot.png")).toBeNull();
		expect(resolveInProject(42)).toBeNull();
		expect(resolveInProject(undefined)).toBeNull();
		expect(resolveInProject(path.join(project, "nope.png"))).toBeNull();
	});

	it("refuses the wrong kind", () => {
		expect(resolveInProject(path.join(project, "sub"), "file")).toBeNull();
		expect(
			resolveInProject(path.join(project, "sub", "shot.png"), "directory"),
		).toBeNull();
	});
});

describe("resolveUnder", () => {
	it("joins a relative path under its base", () => {
		expect(resolveUnder(project, "sub/shot.png", "file")).toBe(
			path.join(project, "sub", "shot.png"),
		);
	});

	it("refuses an absolute path, a climb and a symlink out", () => {
		expect(resolveUnder(project, path.join(outside, "id_rsa"))).toBeNull();
		expect(resolveUnder(project, "../outside/id_rsa")).toBeNull();
		expect(resolveUnder(project, "link/id_rsa")).toBeNull();
	});
});

describe("resolveKnownProject", () => {
	it("accepts a registered project, and only it", () => {
		expect(resolveKnownProject(project)).toBe(project);
		expect(resolveKnownProject(path.join(project, "sub"))).toBeNull();
		expect(resolveKnownProject(sibling)).toBeNull();
		expect(resolveKnownProject(outside)).toBeNull();
	});
});

describe("resolveWithinRoots", () => {
	it("uses the roots it is given", () => {
		expect(resolveWithinRoots(path.join(outside, "id_rsa"), [outside])).toBe(
			path.join(outside, "id_rsa"),
		);
	});
});

describe("isAddableProject", () => {
	it("accepts a registered project or a folder picked in the dialog only", () => {
		forgetUserChosenPaths();
		expect(isAddableProject(project)).toBe(true);
		expect(isAddableProject(outside)).toBe(false);
		expect(isAddableProject("/")).toBe(false);
		rememberUserChosenPath(outside);
		expect(isAddableProject(outside)).toBe(true);
		expect(isAddableProject(path.join(outside, "id_rsa"))).toBe(false);
		forgetUserChosenPaths();
	});
});
