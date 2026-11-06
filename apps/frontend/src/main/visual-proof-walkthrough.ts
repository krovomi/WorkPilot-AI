/**
 * The scenario walkthrough in the visual proof (F5).
 *
 * The verification writes `scenario-walkthrough.gif` in the task's spec
 * folder (`apps/backend/verify/walkthrough.py`): the captures of each step of
 * the card's scenario, in order. When the person ticks it in the PR dialog,
 * the GIF is copied into the visual proof's run folder, pushed with the
 * captures (the run folder alone, `commitAndPushArtifacts`) and shown in the
 * PR comment under "Walkthrough", linked from the branch like the captures: a
 * GIF shows inline in a GitHub comment, a video does not.
 *
 * Only a regular file named by the verification, inside one of the two spec
 * copies, under its ceiling and starting like a GIF is copied: never a link,
 * never a path from the renderer.
 */
import { copyFileSync, lstatSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import type { VisualProofScreenshot } from "../shared/types";

export const WALKTHROUGH_SOURCE = "scenario-walkthrough.gif";
export const WALKTHROUGH_FILE = "walkthrough.gif";
/** The backend's own ceiling (`GIF_MAX_BYTES`): a bigger file was not written by it. */
export const WALKTHROUGH_MAX_BYTES = 6 * 1024 * 1024;
const WALKTHROUGH_LABEL = "Scenario walkthrough";

export interface WalkthroughPlace {
	/** The task's worktree (or the project when there is none). */
	runPath: string;
	projectPath: string;
	/** The specs folder relative to a checkout (`.workpilot/specs`). */
	specsBaseDir: string;
	specId: string;
	artifactDir: string;
	relativeArtifactDir: string;
}

function startsLikeGif(file: string): boolean {
	const head = Buffer.alloc(6);
	const fd = openSync(file, "r");
	try {
		readSync(fd, head, 0, 6, 0);
	} finally {
		closeSync(fd);
	}
	return head.toString("latin1").startsWith("GIF8");
}

/** The newest walkthrough of the two spec copies, or null. */
export function findWalkthrough(place: WalkthroughPlace): { file: string; mtimeMs: number } | null {
	let best: { file: string; mtimeMs: number } | null = null;
	for (const root of new Set([place.runPath, place.projectPath])) {
		const file = path.join(root, place.specsBaseDir, place.specId, "verify", WALKTHROUGH_SOURCE);
		try {
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.size === 0 || stat.size > WALKTHROUGH_MAX_BYTES) continue;
			if (!startsLikeGif(file)) continue;
			if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
		} catch {
			// No walkthrough in this copy.
		}
	}
	return best;
}

/** Copy the walkthrough into the run folder; the capture-shaped entry, or undefined. */
export function copyWalkthrough(place: WalkthroughPlace): VisualProofScreenshot | undefined {
	const found = findWalkthrough(place);
	if (!found) return undefined;
	const absolutePath = path.join(place.artifactDir, WALKTHROUGH_FILE);
	try {
		copyFileSync(found.file, absolutePath);
	} catch {
		return undefined;
	}
	return {
		label: WALKTHROUGH_LABEL,
		relativePath: path.join(place.relativeArtifactDir, WALKTHROUGH_FILE),
		absolutePath,
		width: 0,
		height: 0,
		capturedAt: new Date(found.mtimeMs).toISOString(),
	};
}

export function normalizePathForMarkdown(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

/** The image URL of a capture in the PR comment: GitHub's, else on the branch. */
export function proofImageUrl(screenshot: VisualProofScreenshot, branch?: string): string {
	if (screenshot.url) return screenshot.url;
	const relative = normalizePathForMarkdown(screenshot.relativePath);
	return branch ? `blob/${branch}/${relative}?raw=1` : relative;
}

/** The "Walkthrough" section of the PR comment; nothing without a walkthrough. */
export function walkthroughSection(walkthrough: VisualProofScreenshot | undefined, branch?: string): string[] {
	if (!walkthrough) return [];
	return ["### Walkthrough", "", `![${walkthrough.label}](${proofImageUrl(walkthrough, branch)})`, ""];
}
