/**
 * Reads what the code links (`code-links.ts`) need for one spec (#358, lot 3):
 * the files of its footprint, from its worktree when it has one (the code as
 * the spec leaves it), from the project otherwise (the code as it is), and
 * the worktree's diff since its merge-base.
 *
 * The paths come from a plan an agent wrote and from git: each one is
 * resolved (links included) and must stay inside the root it is read from;
 * the file opened must be the one resolved (same device and inode); it is
 * read only when it is a regular file under `MAX_CODE_FILE_BYTES`, and only
 * when it is text. Dependency manifests and shared configuration (`.env`
 * among them) are never read: they are scored as shared files already, and a
 * value they hold must not become a symbol. A symbol the secret redaction
 * would mask is dropped as well. Bounded per spec and per plan.
 */

import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../../shared/utils/secret-redaction";
import { normalizePlanPath } from "../utils/plan-conflicts";
import { isPathWithinBase } from "../worktree-paths";
import { buildSpecCode, type CodeFile, type SpecCode } from "./code-links";
import { type Footprint, fileWeight } from "./scorer";
import { keepDiffSections, type SpecCodeSource } from "./worktree-files";

export const MAX_CODE_FILE_BYTES = 256 * 1024;
export const MAX_SPEC_CODE_FILES = 300;
export const MAX_PLAN_CODE_FILES = 3000;
/** Files read at once, so that a large plan never holds many descriptors. */
const READ_BATCH = 16;
/** A NUL byte in the first bytes means binary content. */
const BINARY_PROBE_BYTES = 8000;

/** Files read so far for one plan, and whether the limit cut a read. */
export interface CodeReadBudget {
	read: number;
	capped: boolean;
}

/** A file scored by its role (manifest, configuration) is never read for code. */
function isCodeFile(normalized: string): boolean {
	return fileWeight(normalized) === 1;
}

/**
 * The text of `relative` under `root` (already resolved), or null: outside
 * the root once resolved, missing, not a regular file, swapped between the
 * check and the open, too large, or binary.
 */
export async function readTextInside(root: string, relative: string): Promise<string | null> {
	let handle: fs.promises.FileHandle | null = null;
	try {
		const real = await fs.promises.realpath(path.resolve(root, relative));
		if (real === root || !isPathWithinBase(real, root)) return null;
		const checked = await fs.promises.stat(real);
		if (!checked.isFile() || checked.size > MAX_CODE_FILE_BYTES) return null;
		handle = await fs.promises.open(real, "r");
		const opened = await handle.stat();
		if (opened.ino !== checked.ino || opened.dev !== checked.dev) return null;
		const buffer = Buffer.alloc(MAX_CODE_FILE_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_CODE_FILE_BYTES) return null;
		const content = buffer.subarray(0, bytesRead);
		if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
		return content.toString("utf-8");
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

/**
 * Reads one spec's code and indexes it. Files beyond the spec's or the
 * plan's limit are not read, and the budget says so.
 */
export async function readSpecCode(
	source: SpecCodeSource,
	projectPath: string,
	footprint: Footprint,
	budget: CodeReadBudget,
): Promise<SpecCode> {
	let root: string | null = null;
	try {
		root = await fs.promises.realpath(source.worktree ?? projectPath);
	} catch {
		root = null;
	}
	const wanted = [...footprint].filter(([normalized]) => isCodeFile(normalized));
	const allowed = Math.max(
		0,
		Math.min(wanted.length, MAX_SPEC_CODE_FILES, MAX_PLAN_CODE_FILES - budget.read),
	);
	if (allowed < wanted.length) budget.capped = true;
	budget.read += allowed;

	const files: CodeFile[] = [];
	const batch = wanted.slice(0, allowed);
	for (let i = 0; root !== null && i < batch.length; i += READ_BATCH) {
		const texts = await Promise.all(
			batch
				.slice(i, i + READ_BATCH)
				.map(([, display]) => readTextInside(root as string, display)),
		);
		texts.forEach((text, j) => {
			if (text !== null) files.push({ path: batch[i + j][0], text });
		});
	}

	const diff =
		source.diff === null
			? null
			: keepDiffSections(source.diff, (file) => isCodeFile(normalizePlanPath(file)));
	const code = buildSpecCode(files, diff);
	return { ...code, removed: code.removed.filter((s) => redactSecrets(s) === s) };
}
