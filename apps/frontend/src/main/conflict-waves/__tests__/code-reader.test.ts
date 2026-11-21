/**
 * Reading a spec's code for code links (#358, lot 3), on real folders: only
 * text files inside the root once resolved, never a manifest or `.env`,
 * bounded per spec and per plan, no secret-shaped symbol.
 */
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type CodeReadBudget,
	MAX_CODE_FILE_BYTES,
	MAX_PLAN_CODE_FILES,
	MAX_SPEC_CODE_FILES,
	readSpecCode,
	readTextInside,
} from "../code-reader";
import { buildFootprint } from "../scorer";

let base: string;
let project: string;
let worktree: string;

beforeAll(() => {
	base = realpathSync(mkdtempSync(path.join(tmpdir(), "code-reader-")));
	project = path.join(base, "project");
	worktree = path.join(base, "worktree");
	for (const dir of [project, worktree, path.join(project, "src"), path.join(worktree, "src")]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(base, "outside.py"), "import secret_module\n");
	writeFileSync(path.join(project, "src", "users.py"), "def load_user():\n    pass\n");
	writeFileSync(path.join(worktree, "src", "users.py"), "def fetch_user():\n    pass\n");
	writeFileSync(path.join(worktree, "src", "cart.py"), "from users import fetch_user\n");
	writeFileSync(path.join(worktree, ".env"), "SESSION_TOKEN_NAME=1\n");
	writeFileSync(path.join(worktree, "package.json"), '{"name": "shop_app"}\n');
	writeFileSync(path.join(worktree, "src", "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
	writeFileSync(path.join(worktree, "src", "huge.txt"), "x".repeat(MAX_CODE_FILE_BYTES + 1));
	symlinkSync(path.join(base, "outside.py"), path.join(worktree, "src", "escape.py"));
	symlinkSync(path.join(worktree, "src", "cart.py"), path.join(worktree, "src", "alias.py"));
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("readTextInside", () => {
	it("reads a text file inside the root, through a link that stays inside", async () => {
		expect(await readTextInside(worktree, "src/cart.py")).toContain("fetch_user");
		expect(await readTextInside(worktree, "src/alias.py")).toContain("fetch_user");
	});

	it.each([
		["a link that leaves the root", "src/escape.py"],
		["a path that climbs out", "../outside.py"],
		["an absolute path elsewhere", "/etc/hostname"],
		["the root itself", "."],
		["a folder", "src"],
		["a missing file", "src/missing.py"],
		["a file over the size limit", "src/huge.txt"],
		["a binary file", "src/logo.png"],
		["a path with a NUL byte", "src/cart.py\0.txt"],
	])("refuses %s", async (_label, relative) => {
		expect(await readTextInside(worktree, relative)).toBeNull();
	});

	it("refuses a file swapped between the check and the open", async () => {
		const real = fs.promises.open;
		vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags) => {
			const handle = await real(file, flags);
			vi.spyOn(handle, "stat").mockResolvedValueOnce({ ino: -1, dev: -1 } as never);
			return handle;
		});
		expect(await readTextInside(worktree, "src/cart.py")).toBeNull();
	});

	it("refuses a file that grew past the limit after the check", async () => {
		const real = fs.promises.open;
		vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags) => {
			const handle = await real(file, flags);
			vi.spyOn(handle, "read").mockResolvedValueOnce({
				bytesRead: MAX_CODE_FILE_BYTES + 1,
				buffer: Buffer.alloc(0),
			} as never);
			return handle;
		});
		expect(await readTextInside(worktree, "src/cart.py")).toBeNull();
	});
});

describe("readSpecCode", () => {
	const fresh = (): CodeReadBudget => ({ read: 0, capped: false });

	it("reads the worktree's files, never a manifest or .env, and its removed symbols", async () => {
		const budget = fresh();
		const footprint = buildFootprint(["src/users.py", "src/cart.py", ".env", "package.json"]);
		const diff = [
			"diff --git a/src/users.py b/src/users.py",
			"@@ -1 +1 @@",
			"-def load_user():",
			"+def fetch_user():",
			"diff --git a/.env b/.env",
			"@@ -1 +1 @@",
			"-SESSION_TOKEN_NAME=1",
		].join("\n");
		const code = await readSpecCode({ worktree, diff }, project, footprint, budget);
		expect(code.imports.get("users")).toEqual(["src/cart.py"]);
		expect(code.symbols.get("fetch_user")).toEqual(["src/users.py", "src/cart.py"]);
		expect(code.symbols.has("shop_app")).toBe(false);
		expect(code.removed).toEqual(["load_user"]);
		expect(budget).toEqual({ read: 2, capped: false });
	});

	it("reads the project when the spec has no worktree yet", async () => {
		const code = await readSpecCode(
			{ worktree: null, diff: null },
			project,
			buildFootprint(["src/users.py"]),
			fresh(),
		);
		expect(code.symbols.get("load_user")).toEqual(["src/users.py"]);
		expect(code.removed).toEqual([]);
	});

	it("drops a removed symbol the secret redaction would mask", async () => {
		const token = `ghp_${"a1".repeat(18)}`;
		const diff = `diff --git a/src/users.py b/src/users.py\n@@ -1 +1 @@\n-${token} old_name_kept\n`;
		const code = await readSpecCode({ worktree, diff }, project, buildFootprint(["src/users.py"]), fresh());
		expect(code.removed).toEqual(["old_name_kept"]);
	});

	it("reads nothing from a root that cannot be resolved, and still counts the budget", async () => {
		const budget = fresh();
		const code = await readSpecCode(
			{ worktree: path.join(base, "gone"), diff: null },
			project,
			buildFootprint(["src/users.py"]),
			budget,
		);
		expect(code.symbols.size).toBe(0);
		expect(budget.read).toBe(1);
	});

	it("stops at the spec's limit and at the plan's", async () => {
		const many = Array.from({ length: MAX_SPEC_CODE_FILES + 2 }, (_, i) => `src/gen_${i}.py`);
		const budget = fresh();
		await readSpecCode({ worktree: null, diff: null }, project, buildFootprint(many), budget);
		expect(budget).toEqual({ read: MAX_SPEC_CODE_FILES, capped: true });

		const nearlyFull: CodeReadBudget = { read: MAX_PLAN_CODE_FILES - 1, capped: false };
		await readSpecCode({ worktree: null, diff: null }, project, buildFootprint(["a.py", "b.py"]), nearlyFull);
		expect(nearlyFull).toEqual({ read: MAX_PLAN_CODE_FILES, capped: true });
	});
});
