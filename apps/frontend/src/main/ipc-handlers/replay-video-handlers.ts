/**
 * Sharing a recorded agent session (#347), lot 2: a video of the replay (WebM,
 * or MP4 encoded again by the backend's ffmpeg), a video of two sessions side
 * by side, and a model's summary of its steps.
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
import { recordReplayExport } from "../replay-usage";
import { backendFetch } from "./_backend-fetch";
import { isReplayId } from "./replay-handlers";

/** As `MAX_VIDEO_BYTES` in `apps/backend/replay/video.py`. */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
/** The backend's deadline (`DEADLINE_SECONDS`), and time to send the file. */
const VIDEO_TIMEOUT_MS = 240_000;
/** The backend gives ffmpeg 120 s for an MP4 (`replay/mp4.py`). */
const MP4_TIMEOUT_MS = 120_000;
/** The backend gives the model 120 s. */
const SUMMARY_TIMEOUT_MS = 150_000;
const EXTENSION = ".webm";
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
/** An MP4 starts with the size of its first box, then `ftyp`. */
const MP4_BOX = Buffer.from("ftyp");
const FORMATS = {
	webm: { extension: ".webm", filter: { name: "WebM", extensions: ["webm"] } },
	mp4: { extension: ".mp4", filter: { name: "MP4", extensions: ["mp4"] } },
} as const;
type VideoFormat = keyof typeof FORMATS;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** A provider name as the backend's clients know it (`SummarizeRequest`). */
const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const REFUSALS = new Set<ReplayVideoRefusal>([
	"no_playwright",
	"no_browser",
	"no_encoder",
	"no_mp4_encoder",
]);

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
	format: VideoFormat;
}

/** The video the renderer asks for, or null when malformed. */
export function videoBody(raw: unknown): VideoBody | null {
	if (!raw || typeof raw !== "object") return null;
	const source = raw as Record<string, unknown>;
	const reasoning = flag(source.stripReasoning);
	const tokens = flag(source.stripTokens);
	if (reasoning === null || tokens === null) return null;
	const format = source.format ?? "webm";
	if (format !== "webm" && format !== "mp4") return null;
	return {
		strip_reasoning: reasoning,
		strip_tokens: tokens,
		language: language(source.language),
		format,
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

/** The bytes the backend recorded, only when they are a video of `format` within the bound. */
export function exportedVideo(raw: unknown, format: VideoFormat = "webm"): Buffer | null {
	if (typeof raw !== "string" || !BASE64.test(raw)) return null;
	if (raw.length > Math.ceil(MAX_VIDEO_BYTES / 3) * 4) return null;
	const bytes = Buffer.from(raw, "base64");
	if (bytes.length > MAX_VIDEO_BYTES) return null;
	const valid =
		format === "mp4"
			? bytes.subarray(4, 8).equals(MP4_BOX)
			: bytes.subarray(0, WEBM_MAGIC.length).equals(WEBM_MAGIC);
	return valid ? bytes : null;
}

/**
 * The file to write for the path the dialog gave: its folder resolved (links
 * included) and checked to be a folder, its name ending in `extension`
 * (`.webm` or `.mp4`), and no link or folder already in its place. Null when
 * it is not one to write.
 */
export async function saveTarget(
	chosen: string,
	extension: string = EXTENSION,
): Promise<string | null> {
	if (!chosen || chosen.includes("\0")) return null;
	let name = path.basename(chosen);
	if (!name || name === "." || name === "..") return null;
	if (path.extname(name).toLowerCase() !== extension) name += extension;
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

/** Ask the backend to record at `route`, then save what it made where the person says. */
async function recordAndSave(
	route: string,
	body: VideoBody & { session_a_id?: string; session_b_id?: string },
): Promise<ReplayVideoResult> {
	const built = await backendFetch<VideoAnswer>(
		route,
		json(body),
		body.format === "mp4" ? VIDEO_TIMEOUT_MS + MP4_TIMEOUT_MS : VIDEO_TIMEOUT_MS,
	);
	if (!built.success) return built;
	if (built.available === false) {
		const refusal = built.refusal as ReplayVideoRefusal;
		return REFUSALS.has(refusal)
			? { success: true, refused: refusal }
			: { success: false, error: "bad_export" };
	}
	const content = exportedVideo(built.content_base64, body.format);
	if (!content) return { success: false, error: "bad_export" };
	const { extension, filter } = FORMATS[body.format];
	const { canceled, filePath } = await showSaveDialog({
		defaultPath: path.basename(String(built.file_name ?? `replay${extension}`)),
		filters: [{ name: filter.name, extensions: [...filter.extensions] }],
	});
	if (canceled || !filePath) return { success: true, canceled: true };
	const target = await saveTarget(filePath, extension);
	if (!target || !(await writeVideo(target, content))) {
		return { success: false, error: "bad_target" };
	}
	await recordReplayExport("video");
	return {
		success: true,
		filePath: target,
		stepsPlayed: count(built.steps_played),
		stepsTotal: count(built.steps_total),
	};
}

async function exportVideo(
	sessionId: unknown,
	options: unknown,
): Promise<ReplayVideoResult> {
	if (!isReplayId(sessionId)) return invalid("session id");
	const body = videoBody(options);
	if (!body) return invalid("video options");
	return recordAndSave(`/replay/sessions/${sessionId}/video`, body);
}

/** Two sessions side by side, their steps played at once. */
async function exportComparisonVideo(
	sessionAId: unknown,
	sessionBId: unknown,
	options: unknown,
): Promise<ReplayVideoResult> {
	if (!isReplayId(sessionAId) || !isReplayId(sessionBId)) return invalid("session id");
	const body = videoBody(options);
	if (!body) return invalid("video options");
	return recordAndSave("/replay/compare/video", {
		...body,
		session_a_id: sessionAId,
		session_b_id: sessionBId,
	});
}

export function registerReplayVideoHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.REPLAY_EXPORT_VIDEO,
		(_e, sessionId: unknown, options: unknown) => exportVideo(sessionId, options),
	);

	ipcMain.handle(
		IPC_CHANNELS.REPLAY_EXPORT_COMPARISON_VIDEO,
		(_e, sessionAId: unknown, sessionBId: unknown, options: unknown) =>
			exportComparisonVideo(sessionAId, sessionBId, options),
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
