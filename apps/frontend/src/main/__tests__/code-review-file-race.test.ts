// @vitest-environment node
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
	afterStat: null as (() => Promise<void>) | null,
	closed: [] as boolean[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...fs,
		stat: async (...args: Parameters<typeof fs.stat>) => {
			const info = await fs.stat(...args);
			await boundary.afterStat?.();
			return info;
		},
		open: async (...args: Parameters<typeof fs.open>) => {
			const handle = await fs.open(...args);
			const stat = handle.stat.bind(handle);
			const close = handle.close.bind(handle);
			const index = boundary.closed.push(false) - 1;
			handle.stat = (async () => {
				const info = await stat();
				await boundary.afterStat?.();
				return info;
			}) as typeof handle.stat;
			handle.close = async () => {
				await close();
				boundary.closed[index] = true;
			};
			return handle;
		},
	};
});
import { readReviewFile } from "../code-review-service";

let root: string;
afterEach(async () => {
	boundary.afterStat = null;
	boundary.closed = [];
	if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	root = await mkdtemp(join(tmpdir(), "review-race-"));
	execFileSync("git", ["init"], { cwd: root });
	const file = join(root, "source.ts");
	await writeFile(file, "original content\n");
	return file;
}
it("reads the checked file even when its pathname is replaced after inspection", async () => {
	const file = await fixture();
	boundary.afterStat = async () => {
		await rename(file, join(root, "original.ts"));
		await writeFile(file, "replacement content\n");
	};
	const result = await readReviewFile(root, "source.ts", "working");
	expect(result.content).toBe("original content\n");
	expect(boundary.closed).toEqual([true]);
});
it("rejects a file that grows beyond the limit after inspection", async () => {
	const file = await fixture();
	boundary.afterStat = async () => {
		await appendFile(file, "x".repeat(1024 * 1024));
	};
	const result = await readReviewFile(root, "source.ts", "working");
	expect(result.unavailable).toBe("large");
	expect(result.content).toBe("");
	expect(boundary.closed).toEqual([true]);
});
it("closes the descriptor if inspection fails", async () => {
	await fixture();
	boundary.afterStat = async () => {
		throw new Error("inspection failed");
	};
	await expect(readReviewFile(root, "source.ts", "working")).rejects.toThrow(
		"inspection failed",
	);
	expect(boundary.closed).toEqual([true]);
});
