// What holds the backend's port when `pnpm dev` starts it (dev-server.mjs).
// Kept apart from the launcher so tests/test_dev_port.py can drive it against
// real sockets without starting uvicorn.
//
// uvicorn alone answers a busy port with "[Errno 98] Address already in use"
// and exit code 3, which fails the whole `pnpm run dev`. The usual holder is a
// WorkPilot backend still running from an earlier run (a terminal closed
// without Ctrl+C, a detached session) or the one Electron's main started
// because this launcher was still installing dependencies. Both serve the app
// as well as a new one would, so the launcher reuses them; anything else is
// named with the command that shows who holds the port.
//
// When that other program sits on the default port and nobody chose a port
// (BACKEND_PORT), the backend moves to the next free one (chooseDevPort):
// under WSL with mirrored networking, a Windows program that only keeps dead
// connections on 9000 (VS Code's port forwarding does) blocks it with nothing
// listening, and stopping it is not always the user's wish. The root launcher
// (scripts/dev.mjs) makes that choice once and hands the port to both the
// backend and the app as BACKEND_PORT.

import { request } from "node:http";
import { createServer } from "node:net";

export const DEV_HOST = "127.0.0.1";
export const DEV_PORT = 9000;

/** How many ports after the default one the backend may move to. */
export const FALLBACK_SPAN = 20;

/** How long a WorkPilot backend found starting up may take to answer /health. */
export const STARTING_GRACE_MS = 10_000;

/**
 * Whether a /health answer comes from a WorkPilot backend: provider_api.py
 * answers 200 with a JSON verdict, "healthy" or "degraded", in every mode.
 *
 * @param {number | undefined} statusCode
 * @param {string} body
 * @returns {boolean}
 */
export function isWorkPilotHealth(statusCode, body) {
	if (statusCode !== 200) return false;
	try {
		const parsed = JSON.parse(body);
		return (
			parsed !== null &&
			typeof parsed === "object" &&
			(parsed.status === "healthy" || parsed.status === "degraded")
		);
	} catch {
		return false;
	}
}

/**
 * GET /health on host:port, bounded by timeoutMs and by the body size.
 *
 * @returns {Promise<boolean>} true when a WorkPilot backend answered
 */
export function probeWorkPilot(host, port, timeoutMs = 3000) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const req = request(
			{ host, port, path: "/health", method: "GET", timeout: timeoutMs },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
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

/**
 * Whether this process could listen on host:port right now (closed at once).
 *
 * @returns {Promise<boolean>}
 */
export function canListen(host, port) {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", () => resolve(false));
		server.listen({ host, port, exclusive: true }, () => {
			server.close(() => resolve(true));
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The port BACKEND_PORT names: a whole number from 1024 to 65535, or null when
 * it is unset or not one (the caller says so).
 *
 * @param {string | undefined} raw
 * @returns {number | null}
 */
export function parsePort(raw) {
	const text = String(raw ?? "").trim();
	if (!/^\d{4,5}$/.test(text)) return null;
	const port = Number(text);
	return port >= 1024 && port <= 65535 ? port : null;
}

/**
 * "workpilot" when a WorkPilot backend serves the port (one that is still
 * starting gets graceMs to answer), "free" when nothing listens, "other" when
 * something that is not a WorkPilot backend holds it.
 *
 * @returns {Promise<"workpilot" | "free" | "other">}
 */
export async function devPortState(
	host = DEV_HOST,
	port = DEV_PORT,
	{ graceMs = STARTING_GRACE_MS, probe = probeWorkPilot, listen = canListen } = {},
) {
	if (await probe(host, port)) return "workpilot";
	if (await listen(host, port)) return "free";
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
		if (await probe(host, port)) return "workpilot";
		if (await listen(host, port)) return "free";
	}
	return "other";
}

/**
 * The port this run's backend uses. A port the user chose (BACKEND_PORT) is
 * kept as it is, even when busy: checkDevPort then names its holder. Otherwise
 * the default port, or the first port after it that is free or already serves
 * a WorkPilot backend (one an earlier run moved there is reused).
 *
 * @returns {Promise<{ port: number, movedFrom?: number } | null>} null when
 *   every port of the span is held by another program
 */
export async function chooseDevPort({
	host = DEV_HOST,
	preferred = DEV_PORT,
	chosen = null,
	span = FALLBACK_SPAN,
	state = devPortState,
} = {}) {
	if (chosen !== null) return { port: chosen };
	if ((await state(host, preferred)) !== "other") return { port: preferred };
	for (let port = preferred + 1; port <= preferred + span && port <= 65535; port++) {
		if ((await state(host, port, { graceMs: 0 })) !== "other") {
			return { port, movedFrom: preferred };
		}
	}
	return null;
}

/** @returns {string} */
export function movedPortMessage(from, to) {
	return [
		`[backend] Port ${from} is used by a program that is not a WorkPilot backend: this run uses port ${to}, for the backend and the app alike.`,
		"[backend] To always use the same port, set BACKEND_PORT in .env-files/.env.",
	].join("\n");
}

/** @returns {string} */
export function noFreePortMessage(from = DEV_PORT, span = FALLBACK_SPAN) {
	return `[backend] Ports ${from} to ${from + span} are all used by other programs. Set BACKEND_PORT in .env-files/.env to a free port, then run \`pnpm run dev\` again.`;
}

/** @returns {string} */
export function invalidPortMessage(raw) {
	return `[backend] BACKEND_PORT=${JSON.stringify(String(raw))} is not a port from 1024 to 65535: it is ignored.`;
}

/** @returns {string} */
export function reuseMessage(host = DEV_HOST, port = DEV_PORT) {
	return [
		`[backend] A WorkPilot backend already answers on http://${host}:${port}: the app uses it, this one is not started.`,
		"[backend] It may be from an earlier run and so not reload on code changes: stop it, then run `pnpm run dev` again to get a reloading one.",
	].join("\n");
}

/**
 * How to see what holds the port, in the commands of this OS.
 *
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env read for WSL only
 * @returns {string}
 */
export function portBusyMessage(
	port = DEV_PORT,
	platform = process.platform,
	env = process.env,
) {
	const lines = [
		`[backend] Port ${port} is already used by a program that is not a WorkPilot backend, so the backend cannot start.`,
		"[backend] Find it, stop it, then run `pnpm run dev` again:",
	];
	if (platform === "win32") {
		lines.push(
			`  netstat -ano | findstr :${port}`,
			"  taskkill /PID <pid> /F",
		);
	} else if (platform === "darwin") {
		lines.push(`  lsof -nP -iTCP:${port} -sTCP:LISTEN`, "  kill <pid>");
	} else {
		lines.push(`  ss -ltnp 'sport = :${port}'`, "  kill <pid>");
		if (env.WSL_DISTRO_NAME) {
			lines.push(
				`[backend] Under WSL with mirrored networking a Windows program can hold it too: \`netstat -ano | findstr :${port}\` in PowerShell.`,
				"[backend] Connections left in CLOSE_WAIT with no LISTENING line still hold it: VS Code's port forwarding leaves those; reloading its window frees them.",
			);
		}
	}
	return lines.join("\n");
}

/**
 * Before installing anything: whether to start uvicorn.
 *
 * @returns {Promise<{ start: true } | { start: false, exitCode: number }>}
 */
export async function checkDevPort({
	host = DEV_HOST,
	port = DEV_PORT,
	state = devPortState,
	log = console.log,
	error = console.error,
} = {}) {
	const found = await state(host, port);
	if (found === "free") return { start: true };
	if (found === "workpilot") {
		log(reuseMessage(host, port));
		return { start: false, exitCode: 0 };
	}
	error(portBusyMessage(port));
	return { start: false, exitCode: 1 };
}

/**
 * uvicorn stopped: the exit code the launcher ends with. A failure while the
 * port went to a WorkPilot backend in the meantime (Electron's main started
 * one while this launcher installed dependencies) is that backend's success.
 *
 * @param {number | null} code uvicorn's exit code (null when killed by a signal)
 * @returns {Promise<number>}
 */
export async function exitCodeAfterUvicorn(
	code,
	{
		host = DEV_HOST,
		port = DEV_PORT,
		state = devPortState,
		log = console.log,
		error = console.error,
	} = {},
) {
	if (code === null || code === 0) return 0;
	const found = await state(host, port, { graceMs: 0 });
	if (found === "workpilot") {
		log(reuseMessage(host, port));
		return 0;
	}
	if (found === "other") error(portBusyMessage(port));
	return code;
}
