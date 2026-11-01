/**
 * Spec Approval IPC Handlers
 *
 * The Spec Approval view is an inbox of the tasks whose plan waits for a
 * person (`human_review` + `plan_review`). Approving or requesting changes
 * goes through the task's own review channel (`TASK_REVIEW`, the same path as
 * the plan approval on the card), which writes `review_state.json`: the file
 * the build reads.
 *
 * This module only reads what the person reviews:
 *   specApproval:getSpec — the spec files of one spec directory
 *
 * It used to keep its own approvals (`.workpilot/spec_approvals.json`,
 * `APPROVED`, `APPROVAL_PENDING`, `CHANGES_REQUESTED`) that no part of the
 * pipeline read: an approval there unblocked nothing, and since nothing wrote
 * `APPROVAL_PENDING`, the pending list was always empty.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";

/** The files of a spec directory the review shows, in display order. */
export const SPEC_REVIEW_FILES = [
	"spec.md",
	"requirements.json",
	"context.json",
	"implementation_plan.json",
] as const;

/**
 * The spec directory of `specId` under `<project>/.workpilot/specs`: the
 * directory of that exact name, else the one its number starts (`001` →
 * `001-add-login`). Names come from `readdir`, never from the caller, so the
 * id cannot point outside the specs folder.
 */
export function findSpecDir(projectDir: string, specId: string): string | null {
	const specsDir = path.join(projectDir, ".workpilot", "specs");
	if (!fs.existsSync(specsDir)) return null;
	const entries = fs.readdirSync(specsDir);
	const exact = entries.find((e) => e === specId);
	const prefix = specId.match(/^(\d+)/)?.[1];
	const byNumber = prefix
		? entries.find((e) => e.startsWith(`${prefix}-`) || e === prefix)
		: undefined;
	const name = exact ?? byNumber;
	if (!name) return null;
	const dir = path.join(specsDir, name);
	return fs.statSync(dir).isDirectory() ? dir : null;
}

export function readSpecForReview(
	projectDir: string,
	specId: string,
): Record<string, string> | null {
	const specDir = findSpecDir(projectDir, specId);
	if (!specDir) return null;
	const result: Record<string, string> = { spec_id: path.basename(specDir) };
	for (const fname of SPEC_REVIEW_FILES) {
		const fpath = path.join(specDir, fname);
		if (fs.existsSync(fpath)) {
			result[fname.replace(".", "_")] = fs.readFileSync(fpath, "utf-8");
		}
	}
	return result;
}

export function registerSpecApprovalHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.SPEC_APPROVAL_GET_SPEC,
		(_event, projectDir: string, specId: string) => {
			try {
				if (typeof specId !== "string" || specId.trim() === "") {
					return { success: false, error: "Spec not found" };
				}
				const data = readSpecForReview(projectDir, specId);
				return data
					? { success: true, data }
					: { success: false, error: "Spec not found" };
			} catch (err) {
				return { success: false, error: String(err) };
			}
		},
	);
}
