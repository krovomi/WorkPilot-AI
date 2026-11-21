/**
 * Sharing a recorded agent session (#347), lot 2: a video of the replay and a
 * model's summary of its steps.
 *
 * The local backend records the video (the masked page, played step by step
 * in a headless browser, `apps/backend/replay/video.py`) and asks the model
 * (`apps/backend/replay/summary.py`). Main checks what the renderer asks for
 * (a session id, booleans, a language and a provider name in closed forms),
 * checks the bytes it gets back are a WebM within the bound, and writes the
 * video where the person chose in a native dialog: the folder is resolved,
 * the file name is forced to `.webm`, and a link in its place is not
 * followed. No Playwright, browser or encoder on the machine is an answer
 * the renderer shows, not an error.
 */

import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	ReplayVideoRefusal,
	ReplayVideoResult,
} from "../../shared/types/replay-share";
import { showSaveDialog } from "../electron-utils";
import { backendFetch } from "./_backend-fetch";
import { isReplayId } from "./replay-handlers";

/** As `MAX_VIDEO_BYTES` in `apps/backend/replay/video.py`. */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
/** The backend's deadline (`DEADLINE_SECONDS`), and time to send the file. */
const VIDEO_TIMEOUT_MS = 240_000;
/** The backend gives the model 120 s. */
const SUMMARY_TIMEOUT_MS = 150_000;
const EXTENSION = ".webm";
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** A provider name as the backend's clients know it (`SummarizeRequest`). */
const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const REFUSALS = new Set<ReplayVideoRefusal>(["no_playwright", "no_browser", "no_encoder"]);

const invalid = (what: string) => ({
	success: false as const,
	error: `Invalid ${what}`,
});

const json = (body: unknown): RequestInit => ({
	method: "POST",
	body: JSON.stringify(body),
});

const language = (value: unknown): "en" | "fr" => (value === "fr" ? "fr" : "en");

function flag(value: unknown): boolean | null {
	if (value === undefined) return false;
	return typeof value === "boolean" ? value : null;
}

export interface VideoBody {
	strip_reasoning: boolean;
	strip_tokens: boolean;
	language: "en" | "fr";
}

/** The video the renderer asks for, or null when malformed. */
export function videoBody(raw: unknown): VideoBody | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	const reasoning = flag(source.stripReasoning);
	const tokens = flag(source.stripTokens);
	if (reasoning === null || tokens === null) return null;
	return {
		strip_reasoning: reasoning,
		strip_tokens: tokens,
		language: language(source.language),
	};
}

/** The summary the renderer asks for, or null when malformed. */
export function summaryBody(
	raw: unknown,
): { provider: string; language: "en" | "fr" } | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	if (typeof source.provider !== "string" || !PROVIDER.test(source.provider)) {
		return null;
	}
	return { provider: source.provider, language: language(source.language) };
}

/** The bytes the backend recorded, only when they are a WebM within the bound. */
export function exportedVideo(raw: unknown): Buffer | null {
	if (typeof raw !== "string" || !BASE64.test(raw)) return null;
	if (raw.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4) return null;
	const bytes = Buffer.from(raw, "base64");
	if (bytes.length > MAX_VIDEO_BYTES) return null;
	return bytes.subarray(0, WEBM_MAGIC.length).equals(WEBM_MAGIC) ? bytes : null;
}

/**
 * The file to write for the path the dialog gave: its folder resolved (links
 * included) and checked to be a folder, its name ending in `.webm`, and no
 * link or folder already in its place. Null when it is not one to write.
 */
export async function saveTarget(chosen: string): Promise<string | null> {
	if (!chosen || chosen.includes("\0")) return null;
	let name = path.basename(chosen);
	if (!name || name === "." || name === "..") return null;
	if (path.extname(name).toLowerCase() !== EXTENSION) name += EXTENSION;
	try {
		const folder = await realpath(path.dirname(path.resolve(chosen)));
		if (!(await stat(folder)).isDirectory()) return null;
		const target = path.join(folder, name);
		const existing = await lstat(target).catch(() => null);
		if (existing && !existing.isFile()) return null;
		return target;
	} catch {
		return null;
	}
}

/**
 * Writes through one handle. A link put in the file's place since the dialog
 * is refused here, and, where the OS has `O_NOFOLLOW` (not Windows, where it
 * is undefined and `| 0` leaves it out), by the open itself.
 */
export async function writeVideo(target: string, content: Buffer): Promise<boolean> {
	const flags =
		constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW | 0);
	try {
		const existing = await lstat(target).catch(() => null);
		if (existing && !existing.isFile()) return false;
		const handle = await open(target, flags, 0o644);
		try {
			await handle.writeFile(content);
		} finally {
			await handle.close();
		}
		return true;
	} catch {
		return false;
	}
}

interface VideoAnswer {
	available?: boolean;
	refusal?: unknown;
	file_name?: unknown;
	content_base64?: unknown;
	steps_played?: unknown;
	steps_total?: unknown;
}

const count = (value: unknown): number =>
	Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;

async function exportVideo(
	sessionId: unknown,
	options: unknown,
): Promise<ReplayVideoResult> {
	if (!isReplayId(sessionId)) return invalid("session id");
	const body = videoBody(options);
	if (!body) return invalid("video options");
	const built = await backendFetch<VideoAnswer>(
		`/replay/sessions/${sessionId}/video`,
		json(body),
		VIDEO_TIMEOUT_MS,
	);
	if (!built.success) return built;
	if (built.available === false) {
		const refusal = built.refusal as ReplayVideoRefusal;
		return REFUSALS.has(refusal)
			? { success: true, refused: refusal }
			: { success: false, error: "bad_export" };
	}
	const content = exportedVideo(built.content_base64);
	if (!content) return { success: false, error: "bad_export" };
	const { canceled, filePath } = await showSaveDialog({
		defaultPath: path.basename(String(built.file_name ?? `replay${EXTENSION}`)),
		filters: [{ name: "WebM", extensions: ["webm"] }],
	});
	if (canceled || !filePath) return { success: true, canceled: true };
	const target = await saveTarget(filePath);
	if (!target || !(await writeVideo(target, content))) {
		return { success: false, error: "bad_target" };
	}
	return {
		success: true,
		filePath: target,
		stepsPlayed: count(built.steps_played),
		stepsTotal: count(built.steps_total),
	};
}

export function registerReplayVideoHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.REPLAY_EXPORT_VIDEO,
		(_e, sessionId: unknown, options: unknown) => exportVideo(sessionId, options),
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_SUMMARIZE_SESSION,
		(_e, sessionId: unknown, request: unknown) => {
			if (!isReplayId(sessionId)) return invalid("session id");
			const body = summaryBody(request);
			if (!body) return invalid("summary request");
			return backendFetch(
				`/replay/sessions/${sessionId}/summary`,
				json(body),
				SUMMARY_TIMEOUT_MS,
			);
		},
	);
}
