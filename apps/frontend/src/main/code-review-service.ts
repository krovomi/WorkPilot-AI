import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
	ReviewFileData,
	ReviewFileEntry,
	ReviewScope,
} from "../shared/types/code-review";
const execute = promisify(execFile);
const MAX_BYTES = 1024 * 1024;
async function git(root: string, args: string[]) {
	const { stdout } = await execute(
		"git",
		["--literal-pathspecs", "-c", "core.quotePath=false", ...args],
		{
			cwd: root,
			encoding: "utf8",
			windowsHide: true,
			timeout: 15000,
			maxBuffer: 8 * MAX_BYTES,
		},
	);
	return stdout;
}
export async function listReviewFiles(
	root: string,
): Promise<ReviewFileEntry[]> {
	const [names, status] = await Promise.all([
		git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
		git(root, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--no-renames",
		]),
	]);
	const statuses = new Map(
		status
			.split("\0")
			.filter(Boolean)
			.map((entry) => [entry.slice(3), entry.slice(0, 2)]),
	);
	return [
		...new Set([...names.split("\0").filter(Boolean), ...statuses.keys()]),
	]
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({ path: name, status: statuses.get(name) ?? "  " }));
}
function contained(root: string, target: string) {
	const relative = path.relative(root, target);
	return (
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}
export async function readReviewFile(
	root: string,
	file: string,
	scope: ReviewScope,
): Promise<ReviewFileData> {
	if (
		!["all", "staged", "working"].includes(scope) ||
		typeof file !== "string" ||
		!file ||
		/[\0\r\n]/.test(file) ||
		path.isAbsolute(file) ||
		file.split(/[\\/]/).some((p) => p === ".." || p.toLowerCase() === ".git")
	)
		throw new Error("Invalid review file");
	const actualRoot = await realpath(root);
	const target = path.resolve(actualRoot, file);
	if (!contained(actualRoot, target))
		throw new Error("File is outside project");
	const result: ReviewFileData = { path: file, content: "", patch: "" };
	try {
		const actualFile = await realpath(target);
		if (!contained(actualRoot, actualFile))
			throw new Error("File is outside project");
		const info = await stat(actualFile);
		if (!info.isFile()) throw new Error("Not a regular file");
		if (scope === "staged") {
			/* Contents come from the index below. */
		} else if (info.size > MAX_BYTES) result.unavailable = "large";
		else {
			const bytes = await readFile(actualFile);
			if (bytes.includes(0)) result.unavailable = "binary";
			else result.content = bytes.toString("utf8");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		result.unavailable = "deleted";
	}

	let hasHead = true;
	try {
		await git(root, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		hasHead = false;
	}
	const tracked = Boolean(
		(await git(root, ["ls-files", "--cached", "-z", "--", file])).trim(),
	);
	let inHead = false;
	if (hasHead)
		inHead = Boolean(
			(
				await git(root, ["ls-tree", "--name-only", "-z", "HEAD", "--", file])
			).trim(),
		);
	if (scope === "staged") {
		result.content = "";
		if (!tracked) result.unavailable = inHead ? "deleted" : "missingRevision";
		else {
			const size = Number(await git(root, ["cat-file", "-s", `:${file}`]));
			if (size > MAX_BYTES) result.unavailable = "large";
			else {
				const content = await git(root, ["cat-file", "blob", `:${file}`]);
				result.unavailable = content.includes("\0") ? "binary" : undefined;
				if (!result.unavailable) result.content = content;
			}
		}
	}
	if (result.unavailable === "large" || result.unavailable === "binary")
		return result;

	if (
		(!tracked &&
			!(scope === "all" && inHead) &&
			result.unavailable !== "deleted" &&
			scope !== "staged") ||
		(!hasHead && scope === "all" && result.unavailable !== "deleted")
	) {
		const lines = result.content.replace(/\r\n/g, "\n").split("\n");
		if (lines.at(-1) === "") lines.pop();
		result.patch = `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
	} else {
		const revision =
			scope === "staged"
				? ["--cached"]
				: scope === "all" && hasHead
					? ["HEAD"]
					: [];
		result.patch = await git(root, [
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--unified=3",
			...revision,
			"--",
			file,
		]);
	}
	return result;
}
