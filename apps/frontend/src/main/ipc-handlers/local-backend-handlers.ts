/**
 * The local backend (FastAPI, 127.0.0.1:9000) for the renderer views that read
 * it directly: the quick command bar, the model catalog, the effort plan, the
 * agentic matrix, the Ollama library search, and the agent tools client
 * (`renderer/lib/agent-tools-api.ts`: brain, docintel, hermes, verify, rtk...).
 *
 * They fetched `${import.meta.env.VITE_BACKEND_URL}/...`, a variable the
 * renderer never has (electron-vite reads `.env` files from `src/renderer`):
 * the relative URL reached the Vite dev server, which answered its HTML page,
 * and packaged, a `file://` page has no origin the backend's CORS accepts.
 * Main makes the request instead and hands the raw answer back.
 *
 * What the renderer may ask is closed: GET or POST, a route under one of
 * `ROUTES`, a URL without `..`, and a project or spec folder (`project_dir`,
 * `spec_dir`...) only inside a registered project, in the query or the body.
 */

import { IPC_CHANNELS } from "../../shared/constants/ipc";
import type {
	LocalBackendRequest,
	LocalBackendResponse,
} from "../../shared/types/local-backend";
import { resolveInProject } from "../security/renderer-path";
import { getBackendUrl } from "./_backend-fetch";
import { ipcMain } from "electron";

/** The backend routes the renderer reads, by prefix. */
export const ROUTES = [
	"/providers/",
	"/api/slash-commands",
	"/api/brain/",
	"/api/cost-estimator/",
	"/api/docintel/",
	"/api/hermes/",
	"/api/progress-indicator/",
	"/api/prompt-preview/",
	"/api/qa-promotion/",
	"/api/red-team/",
	"/api/restart/",
	"/api/rtk/",
	"/api/schema-guard/",
	"/api/spec-traceability/",
	"/api/timeline/",
	"/api/uiux/",
	"/api/verify/",
	"/api/virtual-reviewer/",
	"/api/workflow-profile/",
] as const;

/** Keys that name a folder of the user's machine, at any depth. */
const FOLDER_KEYS = new Set([
	"project_dir",
	"project_path",
	"projectDir",
	"projectPath",
	"spec_dir",
	"specDir",
]);

const MAX_URL = 8192;
const MAX_BODY = 1_000_000;
/** The largest file handed to the renderer (a scenario video). */
const MAX_FILE = 200_000_000;
const TIMEOUT_MS = 60_000;

function routeAllowed(pathname: string): boolean {
	return ROUTES.some(
		(route) => pathname === route.replace(/\/$/, "") || pathname.startsWith(route),
	);
}

/** Every folder the value names lies in a registered project. */
function foldersAllowed(value: unknown, depth = 0): boolean {
	if (depth > 8 || value === null || typeof value !== "object") return true;
	for (const [key, item] of Object.entries(value)) {
		if (FOLDER_KEYS.has(key) && item !== undefined && item !== null && item !== "") {
			if (!resolveInProject(item, "directory")) return false;
		} else if (!foldersAllowed(item, depth + 1)) {
			return false;
		}
	}
	return true;
}

/**
 * The request as main will send it, or why it is refused. `url` is the
 * backend-relative URL the renderer named (`/api/rtk/status?project_dir=...`).
 */
export function checkRequest(
	raw: unknown,
):
	| { url: URL; method: "GET" | "POST"; body?: string; binary: boolean }
	| { refused: string } {
	if (!raw || typeof raw !== "object") return { refused: "invalid request" };
	const { method, url, body } = raw as Record<string, unknown>;
	const binary = (raw as Record<string, unknown>).binary === true;
	if (method !== "GET" && method !== "POST") return { refused: "method" };
	if (typeof url !== "string" || !url.startsWith("/") || url.length > MAX_URL) {
		return { refused: "url" };
	}
	const base = getBackendUrl();
	let target: URL;
	try {
		target = new URL(url, base);
	} catch {
		return { refused: "url" };
	}
	// Decoded `..` or a host other than the backend's: never a backend route.
	if (
		target.origin !== new URL(base).origin ||
		decodeURIComponent(target.pathname).split("/").includes("..") ||
		!routeAllowed(target.pathname)
	) {
		return { refused: "route" };
	}
	if (!foldersAllowed(Object.fromEntries(target.searchParams))) {
		return { refused: "folder" };
	}
	if (body === undefined || body === null) return { url: target, method, binary };
	if (method !== "POST" || typeof body !== "string" || body.length > MAX_BODY) {
		return { refused: "body" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { refused: "body" };
	}
	if (!foldersAllowed(parsed)) return { refused: "folder" };
	return { url: target, method, body, binary };
}

export async function localBackendRequest(
	raw: unknown,
): Promise<LocalBackendResponse> {
	const checked = checkRequest(raw);
	if ("refused" in checked) {
		return {
			status: 400,
			contentType: "application/json",
			text: JSON.stringify({ success: false, error: `Refused: ${checked.refused}` }),
		};
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(checked.url, {
			method: checked.method,
			headers: checked.body ? { "Content-Type": "application/json" } : undefined,
			body: checked.body,
			signal: controller.signal,
		});
		const contentType = res.headers.get("content-type") ?? "";
		if (checked.binary) {
			const announced = Number(res.headers.get("content-length") ?? 0);
			if (announced > MAX_FILE) {
				controller.abort();
				return { unreachable: true };
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			if (bytes.byteLength > MAX_FILE) return { unreachable: true };
			return { status: res.status, contentType, bytes };
		}
		return { status: res.status, contentType, text: await res.text() };
	} catch {
		return { unreachable: true };
	} finally {
		clearTimeout(timer);
	}
}

export function registerLocalBackendHandlers(): void {
	ipcMain.handle(
		IPC_CHANNELS.LOCAL_BACKEND_REQUEST,
		(_e, request: LocalBackendRequest) => localBackendRequest(request),
	);
}
