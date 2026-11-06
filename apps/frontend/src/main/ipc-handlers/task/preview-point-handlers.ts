/**
 * Point elements of a task's preview, then tell the agent what to change
 * about each (F10).
 *
 * `start` turns on the DevTools picker in the preview (`main/preview-point.ts`)
 * and keeps what it read, here in the main process, under an id; the
 * renderer only gets a summary to show. `send` turns each kept element and the
 * person's words into a steering message (F1, `steering-handlers.ts`): the
 * person's text is the message, the element (DOM path, HTML, styles, the
 * probable source files, the image's place) is its `context`, which the
 * prompt quotes as page data, never as an instruction (rule 4, S2).
 *
 * The renderer gives ids and text only: the guest id is checked against the
 * window that asks, the task id against the local tasks (rule S6).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../../shared/constants";
import type { IPCResult } from "../../../shared/types";
import type { PointedElementSummary, PointedSendItem } from "../../../shared/types/preview-point";
import type { SteeringMessage } from "../../../shared/types/steering";
import {
	MAX_SOURCE_BYTES,
	MAX_SOURCE_FILES,
	type PointedNode,
	type SourceCandidate,
	type SourceFile,
	composeContext,
	isTemplateFile,
	markersOf,
	rankCandidates,
	selectorOf,
	textOf,
} from "../../../shared/utils/element-sources";
import { MAX_STEERING_CHARS, cleanSteeringText } from "../../../shared/utils/steering";
import { appLog } from "../../app-logger";
import { getToolPath } from "../../cli-tool-manager";
import { cancelPick, pickElement, resolvePreview } from "../../preview-point";
import { findServerCard } from "../../server-board-actions";
import { findTaskWorktree } from "../../worktree-paths";
import { allSpecDirs, getSpecPaths } from "./resume-task";
import { queueLocal } from "./steering-handlers";
import { findTaskAndProject } from "./shared";

const execute = promisify(execFile);
const TASK_ID_MAX = 300;
const ELEMENT_ID = /^[a-f0-9]{32}$/;
/** Elements kept per task until sent: the oldest goes first. */
export const MAX_KEPT = 10;
export const POINTED_DIR = "pointed";

interface Kept {
	node: PointedNode;
	image: Buffer | null;
	candidates: SourceCandidate[];
}

const kept = new Map<string, Map<string, Kept>>();

function refused<T>(code: string): IPCResult<T> {
	return { success: false, error: code };
}

function validTaskId(taskId: unknown): taskId is string {
	return typeof taskId === "string" && taskId.length > 0 && taskId.length <= TASK_ID_MAX;
}

/**
 * The folder the task's code is in (its worktree, or the project for a direct
 * build), or why the task cannot be pointed for: a finished task has no next
 * session to read the message.
 */
function sourceRoot(taskId: string): { root: string } | { error: string } {
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project?.path) return { error: "task_not_found" };
	if (task.status === "done" || task.status === "pr_created") return { error: "task_done" };
	return { root: findTaskWorktree(project.path, task.specId) ?? project.path };
}

/** The worktree's template files, read within its root (rule S4). */
export async function readSourceFiles(root: string): Promise<SourceFile[]> {
	let listed: string;
	try {
		const { stdout } = await execute(
			getToolPath("git"),
			["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 },
		);
		listed = stdout;
	} catch (error) {
		appLog.warn(
			`[PREVIEW-POINT] git ls-files failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown"}`,
		);
		return [];
	}
	const realRoot = await realpath(root);
	const files: SourceFile[] = [];
	for (const rel of listed.split("\0").filter(isTemplateFile).slice(0, MAX_SOURCE_FILES)) {
		const absolute = path.resolve(realRoot, rel);
		if (!absolute.startsWith(realRoot + path.sep)) continue;
		try {
			const stat = await lstat(absolute);
			if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
			files.push({ path: rel.replaceAll("\\", "/"), text: await readFile(absolute, "utf-8") });
		} catch {
			// deleted since the listing: not a candidate
		}
	}
	return files;
}

function summaryOf(id: string, element: Kept): PointedElementSummary {
	const text = textOf(element.node.outerHtml);
	return {
		id,
		selector: selectorOf(element.node.tag, element.node.attributes),
		text: text.length > 80 ? `${text.slice(0, 80)}…` : text,
		candidates: element.candidates.map((c) => ({ path: c.path, line: c.line })),
		image: element.image ? `data:image/png;base64,${element.image.toString("base64")}` : null,
	};
}

export async function startPoint(
	sender: Electron.WebContents,
	taskId: unknown,
	guestId: unknown,
): Promise<IPCResult<PointedElementSummary | null>> {
	if (!validTaskId(taskId)) return refused("task_not_found");
	if (findServerCard(taskId)) return refused("local_only");
	const source = sourceRoot(taskId);
	if ("error" in source) return refused(source.error);
	const guest = resolvePreview(sender, guestId);
	if (!guest) return refused("no_preview");
	let picked: Awaited<ReturnType<typeof pickElement>>;
	try {
		picked = await pickElement(guest);
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		if (code === "devtools_open" || code === "pick_in_progress") return refused(code);
		appLog.warn(`[PREVIEW-POINT] pick failed: ${code.split("\n")[0]}`);
		return refused("pick_failed");
	}
	if (!picked) return { success: true, data: null };
	const candidates = rankCandidates(await readSourceFiles(source.root), markersOf(picked.node));
	const id = randomUUID().replaceAll("-", "");
	const element: Kept = { ...picked, candidates };
	const forTask = kept.get(taskId) ?? new Map<string, Kept>();
	forTask.set(id, element);
	while (forTask.size > MAX_KEPT) forTask.delete(forTask.keys().next().value as string);
	kept.set(taskId, forTask);
	return { success: true, data: summaryOf(id, element) };
}

export function cancelPoint(sender: Electron.WebContents, guestId: unknown): IPCResult<boolean> {
	const guest = resolvePreview(sender, guestId);
	if (!guest) return refused("no_preview");
	return { success: true, data: cancelPick(guest.id) };
}

/** Forget one pointed element (its chip was removed). */
export function discardPoint(taskId: unknown, elementId: unknown): IPCResult<boolean> {
	if (!validTaskId(taskId) || typeof elementId !== "string") return refused("task_not_found");
	return { success: true, data: kept.get(taskId)?.delete(elementId) ?? false };
}

async function saveImage(taskId: string, id: string, image: Buffer): Promise<string | null> {
	const { task, project } = findTaskAndProject(taskId);
	if (!task || !project) return null;
	const rel = `${POINTED_DIR}/${id}.png`;
	let saved = 0;
	for (const dir of allSpecDirs(getSpecPaths(task, project))) {
		try {
			await mkdir(path.join(dir, POINTED_DIR), { recursive: true, mode: 0o700 });
			await writeFile(path.join(dir, rel), image, { mode: 0o600 });
			saved += 1;
		} catch (error) {
			appLog.warn(
				`[PREVIEW-POINT] Could not write the image in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return saved > 0 ? rel : null;
}

export async function sendPoints(
	taskId: unknown,
	items: unknown,
): Promise<IPCResult<SteeringMessage[]>> {
	if (!validTaskId(taskId)) return refused("task_not_found");
	if (findServerCard(taskId)) return refused("local_only");
	const source = sourceRoot(taskId);
	if ("error" in source) return refused(source.error);
	if (!Array.isArray(items) || items.length === 0 || items.length > MAX_KEPT) {
		return refused("empty_message");
	}
	const forTask = kept.get(taskId);
	const ready: Array<{ id: string; text: string; element: Kept }> = [];
	for (const raw of items as PointedSendItem[]) {
		if (!raw || typeof raw.elementId !== "string" || !ELEMENT_ID.test(raw.elementId)) {
			return refused("element_not_found");
		}
		const element = forTask?.get(raw.elementId);
		if (!element) return refused("element_not_found");
		if (typeof raw.text !== "string" || raw.text.length > MAX_STEERING_CHARS * 2) {
			return refused("message_too_long");
		}
		const text = cleanSteeringText(raw.text);
		if (!text) return refused("empty_message");
		ready.push({ id: raw.elementId, text, element });
	}
	let last: IPCResult<SteeringMessage[]> = refused("empty_message");
	for (const { id, text, element } of ready) {
		const image = element.image ? await saveImage(taskId, id, element.image) : null;
		const context = composeContext(element.node, element.candidates, image);
		last = await queueLocal(taskId, text, null, context);
		if (!last.success) return last;
		forTask?.delete(id);
	}
	appLog.info(`[PREVIEW-POINT] ${taskId}: ${ready.length} pointed element(s) sent`);
	return last;
}

export function registerPreviewPointHandlers(): void {
	ipcMain.handle(IPC_CHANNELS.TASK_PREVIEW_POINT_START, (event, taskId: unknown, guestId: unknown) =>
		startPoint(event.sender, taskId, guestId),
	);
	ipcMain.handle(IPC_CHANNELS.TASK_PREVIEW_POINT_CANCEL, (event, guestId: unknown) =>
		cancelPoint(event.sender, guestId),
	);
	ipcMain.handle(IPC_CHANNELS.TASK_PREVIEW_POINT_DISCARD, (_, taskId: unknown, elementId: unknown) =>
		discardPoint(taskId, elementId),
	);
	ipcMain.handle(IPC_CHANNELS.TASK_PREVIEW_POINT_SEND, (_, taskId: unknown, items: unknown) =>
		sendPoints(taskId, items),
	);
}
