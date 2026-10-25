import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ isWindows: () => false }));
vi.mock("./renderer-path", async () => {
	const actual =
		await vi.importActual<typeof import("./renderer-path")>("./renderer-path");
	return { ...actual, knownProjectRoots: () => [] };
});

import {
	isAcceptableToolPath,
	refusedToolPath,
	untrustedToolRoots,
} from "./tool-path-policy";

// Execute bits and symlinks: the real platform decides, the module sees Unix.
const { isWindows: onWindows } =
	await vi.importActual<typeof import("../platform")>("../platform");
const describeUnix = onWindows() ? describe.skip : describe;

describeUnix("isAcceptableToolPath", () => {
	let base: string;
	let tools: string;
	let project: string;
	let roots: string[];

	function executable(dir: string, name: string): string {
		const file = path.join(dir, name);
		writeFileSync(file, "#!/bin/sh\n", "utf-8");
		chmodSync(file, 0o755);
		return file;
	}

	beforeAll(() => {
		base = mkdtempSync(path.join(os.tmpdir(), "tool-path-"));
		tools = path.join(base, "opt", "bin");
		project = path.join(base, "project");
		mkdirSync(tools, { recursive: true });
		mkdirSync(path.join(project, ".venv", "bin"), { recursive: true });
		// The temporary folder itself is left out: these files live in it.
		const tmp = realpathSync(os.tmpdir());
		roots = untrustedToolRoots([project]).filter((root) => root !== tmp);
	});

	afterAll(() => rmSync(base, { recursive: true, force: true }));

	it("accepts a bare tool name, looked up on the PATH", () => {
		expect(isAcceptableToolPath("git", "git", roots)).toBe(true);
		expect(isAcceptableToolPath("python", "python3.12", roots)).toBe(true);
		expect(isAcceptableToolPath("claude", " claude ", roots)).toBe(true);
	});

	it("accepts an empty value, which means auto-detection", () => {
		expect(isAcceptableToolPath("git", "", roots)).toBe(true);
	});

	it("refuses a bare name that is another program", () => {
		expect(isAcceptableToolPath("git", "sh", roots)).toBe(false);
		expect(isAcceptableToolPath("python", "bash", roots)).toBe(false);
	});

	it("accepts the absolute path of an executable named like the tool", () => {
		expect(isAcceptableToolPath("git", executable(tools, "git"), roots)).toBe(
			true,
		);
		expect(
			isAcceptableToolPath("python", executable(tools, "python3"), roots),
		).toBe(true);
	});

	it("judges a link by the name it was given, not by its target", () => {
		const target = executable(tools, "cli.js");
		const link = path.join(tools, "claude");
		symlinkSync(target, link);
		expect(isAcceptableToolPath("claude", link, roots)).toBe(true);
	});

	it("refuses a relative path", () => {
		expect(isAcceptableToolPath("git", "./bin/git", roots)).toBe(false);
	});

	it("refuses a file named like another program", () => {
		expect(isAcceptableToolPath("git", executable(tools, "sh"), roots)).toBe(
			false,
		);
	});

	it("refuses a file that does not exist or cannot run", () => {
		expect(isAcceptableToolPath("git", path.join(tools, "nope", "git"), roots)).toBe(false);
		const plain = path.join(base, "plain");
		mkdirSync(plain);
		writeFileSync(path.join(plain, "git"), "", "utf-8");
		expect(isAcceptableToolPath("git", path.join(plain, "git"), roots)).toBe(
			false,
		);
	});

	it("refuses an executable inside a registered project", () => {
		const venvPython = executable(path.join(project, ".venv", "bin"), "python");
		expect(isAcceptableToolPath("python", venvPython, roots)).toBe(false);
	});

	it("refuses a link outside the project that points into it", () => {
		const inside = executable(project, "git");
		mkdirSync(path.join(base, "opt", "links"), { recursive: true });
		const named = path.join(base, "opt", "links", "git");
		symlinkSync(inside, named);
		expect(isAcceptableToolPath("git", named, roots)).toBe(false);
	});

	it("refuses an executable in the temporary folder", () => {
		const inTmp = executable(base, "glab");
		expect(isAcceptableToolPath("glab", inTmp, untrustedToolRoots([]))).toBe(
			false,
		);
	});
});

describe("refusedToolPath", () => {
	it("keeps a stored value, even one it would refuse today", () => {
		expect(
			refusedToolPath({ gitPath: "./git" }, { gitPath: "./git" }, []),
		).toBeNull();
	});

	it("names the first new value it refuses", () => {
		expect(
			refusedToolPath({ pythonPath: "python3", gitPath: "sh" }, {}, []),
		).toBe("gitPath");
	});

	it("refuses a value that is not a string", () => {
		expect(refusedToolPath({ claudePath: 42 }, {}, [])).toBe("claudePath");
	});

	it("ignores the fields it does not guard and the ones left out", () => {
		expect(
			refusedToolPath(
				{ autoBuildPath: "/anything" } as Record<string, unknown>,
				{},
				[],
			),
		).toBeNull();
	});
});
