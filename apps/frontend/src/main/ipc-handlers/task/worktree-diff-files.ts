/**
 * The files a task changed, as shown in the review's "Fichiers modifiés".
 *
 * The branch's commits are not the whole story: an agent can end its session
 * with a file it created but never committed. The list used to read only
 * `base...HEAD`, so such a file was invisible ("0 files changed") although it
 * sits in the worktree. When the diff is read from the local HEAD, the
 * worktree itself is compared with the merge-base (commits, staged and
 * unstaged changes in one git call) and untracked files are added.
 *
 * A git failure is thrown, never turned into an empty list: an empty review
 * reads as "the task changed nothing", which is a wrong answer, not an error.
 */
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { WorktreeDiffFile } from "../../../shared/types";
import type { ResolvedDiffRefs } from "./worktree-git-refs";

/** Large diffs (a lock file, a generated client) must not overflow the 1 MB default. */
const MAX_DIFF_BUFFER = 256 * 1024 * 1024;
/** Untracked files above this size are listed without their content. */
const MAX_UNTRACKED_PATCH_BYTES = 512 * 1024;
/** Guard against an unignored dependency folder flooding the review. */
const MAX_UNTRACKED_FILES = 500;

function git(gitPath: string, cwd: string, args: string[]): string {
	return execFileSync(gitPath, args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: MAX_DIFF_BUFFER,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

/** Split a `git diff` output into one entry per file. */
export function parseDiffSections(fullDiff: string): WorktreeDiffFile[] {
	const sections: string[] = [];
	let currentLines: string[] = [];
	for (const line of fullDiff.trim().split("\n")) {
		if (line.startsWith("diff --git ")) {
			if (currentLines.length > 0) sections.push(currentLines.join("\n"));
			currentLines = [line];
		} else {
			currentLines.push(line);
		}
	}
	if (currentLines.length > 0) sections.push(currentLines.join("\n"));

	const files: WorktreeDiffFile[] = [];
	for (const section of sections) {
		const headerMatch = section.match(/^diff --git a\/(.*) b\/(.*)$/m);
		if (!headerMatch) continue;

		// Use the b/ (destination) path as canonical — correct for renames too.
		const filePath = headerMatch[2];

		let status: WorktreeDiffFile["status"] = "modified";
		if (/^new file mode/m.test(section)) status = "added";
		else if (/^deleted file mode/m.test(section)) status = "deleted";
		else if (/^rename from /m.test(section)) status = "renamed";

		// Count additions/deletions from the same content as the patch.
		let additions = 0;
		let deletions = 0;
		for (const line of section.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) additions++;
			else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
		}

		files.push({
			path: filePath,
			status,
			additions,
			deletions,
			patch: section || undefined,
		});
	}
	return files;
}

/**
 * The file's text, or null above the size cap. One open descriptor, no
 * stat-then-read: the size is what was actually read.
 */
function readCapped(absolute: string): string | null {
	const fd = openSync(absolute, "r");
	try {
		const buffer = Buffer.alloc(MAX_UNTRACKED_PATCH_BYTES + 1);
		let total = 0;
		while (total < buffer.length) {
			const read = readSync(fd, buffer, total, buffer.length - total, null);
			if (read === 0) break;
			total += read;
		}
		if (total > MAX_UNTRACKED_PATCH_BYTES) return null;
		return buffer.toString("utf-8", 0, total);
	} finally {
		closeSync(fd);
	}
}

/** An "added" entry for a file git does not track yet. */
function untrackedFile(worktreePath: string, filePath: string): WorktreeDiffFile {
	const absolute = path.join(worktreePath, filePath);
	const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n`;
	try {
		const content = readCapped(absolute);
		if (content === null) {
			return { path: filePath, status: "added", additions: 0, deletions: 0 };
		}
		if (content.includes("\0")) {
			return {
				path: filePath,
				status: "added",
				additions: 0,
				deletions: 0,
				patch: `${header}Binary files /dev/null and b/${filePath} differ`,
			};
		}
		const lines = content.endsWith("\n")
			? content.slice(0, -1).split("\n")
			: content.split("\n");
		if (content.length === 0) {
			return { path: filePath, status: "added", additions: 0, deletions: 0 };
		}
		return {
			path: filePath,
			status: "added",
			additions: lines.length,
			deletions: 0,
			patch: `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
		};
	} catch {
		// Deleted between the listing and the read: still a change of the task.
		return { path: filePath, status: "added", additions: 0, deletions: 0 };
	}
}

/**
 * Every file the task changed against its base.
 *
 * With a remote head (`origin/<branch>`, a pushed PR) the published range is
 * the truth and the worktree is not read. Otherwise the worktree is compared
 * with the merge-base, so uncommitted and untracked files count too.
 *
 * `isHidden` drops untracked paths before the size cap (WorkPilot's own
 * files, build outputs), so they cannot crowd out the task's real files.
 *
 * @throws when git cannot compute the diff.
 */
export function collectWorktreeDiffFiles(
	gitPath: string,
	worktreePath: string,
	refs: ResolvedDiffRefs,
	isHidden: (filePath: string) => boolean = () => false,
): WorktreeDiffFile[] {
	if (refs.usingRemoteHead) {
		return parseDiffSections(
			git(gitPath, worktreePath, ["diff", `${refs.baseRef}...${refs.headRef}`]),
		);
	}

	const mergeBase = git(gitPath, worktreePath, [
		"merge-base",
		refs.baseRef,
		"HEAD",
	]).trim();
	// One call for commits + index + working tree: no race between a stats
	// read and a patch read on a worktree that is still being committed to.
	const files = parseDiffSections(
		git(gitPath, worktreePath, ["diff", mergeBase]),
	);

	const known = new Set(files.map((f) => f.path));
	const untracked = git(gitPath, worktreePath, [
		"ls-files",
		"-z",
		"--others",
		"--exclude-standard",
	])
		.split("\0")
		.filter((p) => p && !known.has(p) && !isHidden(p))
		.slice(0, MAX_UNTRACKED_FILES);
	for (const filePath of untracked) {
		files.push(untrackedFile(worktreePath, filePath));
	}
	return files;
}
