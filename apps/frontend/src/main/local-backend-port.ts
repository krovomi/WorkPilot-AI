import { request } from "node:http";
import { createServer } from "node:net";

/**
 * The port of the local backend (FastAPI) this app starts and calls.
 *
 * 9000 unless BACKEND_PORT names another one. `pnpm run dev` (scripts/dev.mjs)
 * always sets it, to the port it chose for the backend and the app alike. A
 * packaged app, or one started alone, chooses here, before the window opens
 * (`chooseLocalBackendPort`): when a program that is not a WorkPilot backend
 * holds 9000, the backend moves to the next port that is free or already
 * serves a WorkPilot backend, the same walk as apps/backend/dev-port.mjs. Under
 * WSL with mirrored networking a Windows program that only keeps dead
 * connections on 9000 (VS Code's port forwarding) blocks it with nothing
 * listening: the app used to give up there.
 *
 * Every caller of the local backend builds its URL with `localBackendUrl()`,
 * at call time, so the chosen port reaches all of them.
 */

export const DEFAULT_LOCAL_BACKEND_PORT = 9000;
/** How many ports after the default one the backend may move to. */
export const FALLBACK_PORT_SPAN = 20;
const HOST = "127.0.0.1";
const PROBE_TIMEOUT_MS = 1_500;

/** A whole number from 1024 to 65535, or null. */
export function parseBackendPort(raw: string | undefined): number | null {
	const text = String(raw ?? "").trim();
	if (!/^\d{4,5}$/.test(text)) return null;
	const port = Number(text);
	return port >= 1024 && port <= 65535 ? port : null;
}

export function localBackendPort(env: NodeJS.ProcessEnv = process.env): number {
	return parseBackendPort(env.BACKEND_PORT) ?? DEFAULT_LOCAL_BACKEND_PORT;
}

/**
 * The local backend's base URL. A valid BACKEND_PORT wins over
 * VITE_BACKEND_URL / BACKEND_URL: the development `.env` written by
 * sync-backend-port-to-frontend-env.cjs can name a port this run moved off.
 */
export function localBackendUrl(env: NodeJS.ProcessEnv = process.env): string {
	const port = parseBackendPort(env.BACKEND_PORT);
	if (port !== null) return `http://${HOST}:${port}`;
	return (
		env.VITE_BACKEND_URL ||
		env.BACKEND_URL ||
		`http://${HOST}:${DEFAULT_LOCAL_BACKEND_PORT}`
	);
}

/** A /health answer from a WorkPilot backend: 200 and its JSON verdict. */
export function isWorkPilotHealth(
	statusCode: number | undefined,
	body: string,
): boolean {
	if (statusCode !== 200) return false;
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed === null || typeof parsed !== "object") return false;
		const status = (parsed as { status?: unknown }).status;
		return status === "healthy" || status === "degraded";
	} catch {
		return false;
	}
}

function probeWorkPilot(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: boolean) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const req = request(
			{
				host: HOST,
				port,
				path: "/health",
				method: "GET",
				timeout: PROBE_TIMEOUT_MS,
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
					if (body.length > 64 * 1024) {
						req.destroy();
						done(false);
					}
				});
				res.on("end", () => done(isWorkPilotHealth(res.statusCode, body)));
				res.on("error", () => done(false));
			},
		);
		req.on("timeout", () => {
			req.destroy();
			done(false);
		});
		req.on("error", () => done(false));
		req.end();
	});
}

function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen({ host: HOST, port, exclusive: true }, () => {
			server.close(() => resolve(true));
		});
	});
}

export type PortState = "free" | "workpilot" | "other";

/** Free first: it answers at once, and it is the usual case. */
export async function localPortState(port: number): Promise<PortState> {
	if (await canListen(port)) return "free";
	return (await probeWorkPilot(port)) ? "workpilot" : "other";
}

export interface PortChoice {
	port: number;
	/** The default port, when another program held it. */
	movedFrom?: number;
}

/**
 * The port for this run: BACKEND_PORT as set, else the default one or the
 * first after it that is free or serves a WorkPilot backend. Null when every
 * port of the span is held by another program.
 */
export async function chooseLocalBackendPort(
	env: NodeJS.ProcessEnv = process.env,
	state: (port: number) => Promise<PortState> = localPortState,
): Promise<PortChoice | null> {
	const configured = parseBackendPort(env.BACKEND_PORT);
	if (configured !== null) return { port: configured };
	const from = DEFAULT_LOCAL_BACKEND_PORT;
	for (let port = from; port <= from + FALLBACK_PORT_SPAN; port++) {
		if ((await state(port)) !== "other") {
			return port === from ? { port } : { port, movedFrom: from };
		}
	}
	return null;
}

/**
 * Chooses the port and records it in BACKEND_PORT, read by `localBackendUrl()`
 * and inherited by the backend main spawns. When no port is free, the default
 * stays: the launch then names what holds it.
 */
export async function settleLocalBackendPort(
	env: NodeJS.ProcessEnv = process.env,
	state?: (port: number) => Promise<PortState>,
): Promise<PortChoice | null> {
	const choice = await chooseLocalBackendPort(env, state);
	env.BACKEND_PORT = String(choice?.port ?? localBackendPort(env));
	return choice;
}
