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

import { request } from "node:http";
import { createServer } from "node:net";

export const DEV_HOST = "127.0.0.1";
export const DEV_PORT = 9000;

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
