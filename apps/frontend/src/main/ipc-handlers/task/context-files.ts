/**
 * The files through which the UI steers the backend's context-window manager.
 *
 * Both are written to EVERY copy of the spec directory (main project and
 * worktree): the running backend reads its *own* copy — the worktree one for
 * a worktree build — and writing only the main one is how a request gets
 * made and never noticed (same reason as `pause_state.json`, HOT_SWAP.json).
 *
 *  - `CONTEXT_ACTION.json`: a one-shot "compact" / "clear", consumed by the
 *    backend at its next safe point. The process keeps running.
 *  - `task_metadata.json` → `contextPolicy`: re-read by the backend during the
 *    run (mtime cache), so a change takes effect live.
 */

import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ContextAction } from "../../../shared/types/context-usage";
import type { ContextPolicy } from "../../../shared/types/task";
import { buildContextActionMarker } from "../../../shared/utils/context-policy";

export const CONTEXT_ACTION_FILE = "CONTEXT_ACTION.json";
export const TASK_METADATA_FILE = "task_metadata.json";

/** Write-then-rename, so the backend never reads half a file. */
function atomicWriteFileSync(filePath: string, content: string): void {
	const tempPath = `${filePath}.${process.pid}.tmp`;
	try {
		writeFileSync(tempPath, content, "utf-8");
		renameSync(tempPath, filePath);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			// The temp file may never have been created.
		}
		throw error;
	}
}

export interface WriteOutcome {
	/** Directories written successfully. */
	written: string[];
	/** Directories that failed, with the reason. */
	failed: Array<{ dir: string; error: unknown }>;
}

/** Drop the one-shot marker in every given spec dir. */
export function writeContextActionMarker(
	specDirs: string[],
	action: ContextAction,
	now: Date = new Date(),
): WriteOutcome {
	const payload = JSON.stringify(buildContextActionMarker(action, now));
	const outcome: WriteOutcome = { written: [], failed: [] };
	for (const dir of specDirs) {
		try {
			atomicWriteFileSync(path.join(dir, CONTEXT_ACTION_FILE), payload);
			outcome.written.push(dir);
		} catch (error) {
			outcome.failed.push({ dir, error });
		}
	}
	return outcome;
}

/**
 * Merge `contextPolicy` into `task_metadata.json` of every spec dir copy,
 * leaving every other key untouched. A copy without a metadata file is
 * skipped — creating a partial one would shadow the real metadata — unless
 * no copy has one at all, in which case the first directory gets it.
 */
export function mergeContextPolicyIntoSpecDirs(
	specDirs: string[],
	policy: ContextPolicy,
): WriteOutcome {
	const outcome: WriteOutcome = { written: [], failed: [] };
	const withMetadata = specDirs.filter((dir) =>
		existsSync(path.join(dir, TASK_METADATA_FILE)),
	);
	const targets =
		withMetadata.length > 0 ? withMetadata : specDirs.slice(0, 1);

	for (const dir of targets) {
		const metadataPath = path.join(dir, TASK_METADATA_FILE);
		try {
			let current: Record<string, unknown> = {};
			if (existsSync(metadataPath)) {
				const parsed = JSON.parse(readFileSync(metadataPath, "utf-8")) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					current = parsed as Record<string, unknown>;
				}
			}
			atomicWriteFileSync(
				metadataPath,
				JSON.stringify({ ...current, contextPolicy: { ...policy } }, null, 2),
			);
			outcome.written.push(dir);
		} catch (error) {
			outcome.failed.push({ dir, error });
		}
	}
	return outcome;
}
