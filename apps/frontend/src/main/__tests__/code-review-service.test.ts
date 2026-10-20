// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { listReviewFiles, readReviewFile } from "../code-review-service";
let roots: string[] = [];
afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots = [];
});
async function repo() {
	const root = await mkdtemp(join(tmpdir(), "review-"));
	roots.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	await writeFile(join(root, "file name.ts"), "const n = 1;\n");
	git("add", ".");
	git("commit", "-m", "initial");
	return { root, git };
}
it("loads real files and distinguishes staged and working changes", async () => {
	const { root, git } = await repo();
	await writeFile(join(root, "file name.ts"), "const n = 2;\n");
	git("add", ".");
	await writeFile(join(root, "file name.ts"), "const n = 3;\n");
	await writeFile(join(root, "new.ts"), "new file\n");
	expect(await listReviewFiles(root)).toEqual(
		expect.arrayContaining([
			{ path: "file name.ts", status: "MM" },
			{ path: "new.ts", status: "??" },
		]),
	);
	expect(
		(await readReviewFile(root, "file name.ts", "staged")).patch,
	).toContain("+const n = 2;");
	expect(
		(await readReviewFile(root, "file name.ts", "working")).patch,
	).toContain("-const n = 2;");
	expect((await readReviewFile(root, "file name.ts", "all")).patch).toContain(
		"-const n = 1;",
	);
	expect((await readReviewFile(root, "new.ts", "all")).patch).toContain(
		"+new file",
	);
});
it("rejects traversal and reports binary and deleted files", async () => {
	const { root, git } = await repo();
	await expect(readReviewFile(root, "../outside", "all")).rejects.toThrow();
	await writeFile(join(root, "binary.bin"), new Uint8Array([0, 1, 2]));
	expect((await readReviewFile(root, "binary.bin", "all")).unavailable).toBe(
		"binary",
	);
	git("rm", "file name.ts");
	const deleted = await readReviewFile(root, "file name.ts", "all");
	expect(deleted.unavailable).toBe("deleted");
	expect(deleted.patch).toContain("-const n = 1;");
});
it("supports repositories without a first commit", async () => {
	const root = await mkdtemp(join(tmpdir(), "review-"));
	roots.push(root);
	execFileSync("git", ["init"], { cwd: root });
	await writeFile(join(root, "first.ts"), "hello\n");
	expect((await readReviewFile(root, "first.ts", "all")).patch).toContain(
		"+hello",
	);
});

it("rejects links outside the project and limits large files", async () => {
	const { root } = await repo();
	const outside = await mkdtemp(join(tmpdir(), "review-outside-"));
	roots.push(outside);
	await writeFile(join(outside, "outside.ts"), "private");
	await symlink(outside, join(root, "linked"), "junction");
	await expect(
		readReviewFile(root, "linked/outside.ts", "all"),
	).rejects.toThrow("outside project");
	await writeFile(join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));
	expect((await readReviewFile(root, "large.txt", "all")).unavailable).toBe(
		"large",
	);
});

it("returns index content for staged review, independently of disk edits", async () => {
	const { root, git } = await repo();
	await writeFile(join(root, "file name.ts"), "const staged = 2;\n");
	git("add", ".");
	await writeFile(
		join(root, "file name.ts"),
		"// local insertion\nconst local = 3;\n",
	);
	expect((await readReviewFile(root, "file name.ts", "staged")).content).toBe(
		"const staged = 2;\n",
	);
});
it("matches git diff HEAD when an existing file is removed from the index", async () => {
	const { root, git } = await repo();
	git("rm", "--cached", "file name.ts");
	const actual = await readReviewFile(root, "file name.ts", "all");
	expect(actual.patch).toBe(
		git(
			"-c",
			"core.quotePath=false",
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--unified=3",
			"HEAD",
			"--",
			"file name.ts",
		),
	);
});
