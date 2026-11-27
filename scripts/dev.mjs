#!/usr/bin/env node
// `pnpm run dev`: the backend and the app, side by side (concurrently).
//
// Both must talk on the same port. It is chosen once, here, before either
// starts: BACKEND_PORT when set (environment, then .env-files/.env), else 9000,
// else the next port that is free or already serves a WorkPilot backend
// (apps/backend/dev-port.mjs). Both children get it as BACKEND_PORT: the
// backend launcher (apps/backend/dev-server.mjs) listens on it and the app's
// main (apps/frontend/src/main/local-backend-port.ts) calls it.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	chooseDevPort,
	invalidPortMessage,
	movedPortMessage,
	noFreePortMessage,
	parsePort,
} from "../apps/backend/dev-port.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * BACKEND_PORT as .env-files/.env sets it (the file main also loads in
 * development), or undefined.
 *
 * @param {string} text the file's content
 * @returns {string | undefined}
 */
export function envFilePort(text) {
	let value;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line.startsWith("BACKEND_PORT=")) continue;
		value = line
			.slice("BACKEND_PORT=".length)
			.trim()
			.replace(/^['"]|['"]$/g, "");
	}
	return value;
}

/** @returns {string | undefined} */
function configuredRaw(env = process.env) {
	if (env.BACKEND_PORT !== undefined && env.BACKEND_PORT !== "") return env.BACKEND_PORT;
	try {
		return envFilePort(readFileSync(join(ROOT, ".env-files", ".env"), "utf-8"));
	} catch {
		return undefined;
	}
}

/**
 * The port of this run, with what to say about it.
 *
 * @returns {Promise<{ port: number, lines: string[] } | { port: null, lines: string[] }>}
 */
export async function devRunPort({ raw = configuredRaw(), choose = chooseDevPort } = {}) {
	const lines = [];
	const chosen = parsePort(raw);
	if (raw !== undefined && raw !== "" && chosen === null) lines.push(invalidPortMessage(raw));
	const choice = await choose({ chosen });
	if (choice === null) return { port: null, lines: [...lines, noFreePortMessage()] };
	if (choice.movedFrom !== undefined) lines.push(movedPortMessage(choice.movedFrom, choice.port));
	return { port: choice.port, lines };
}

async function main() {
	const { port, lines } = await devRunPort();
	for (const line of lines) (port === null ? console.error : console.log)(line);
	if (port === null) process.exit(1);

	const require = createRequire(import.meta.url);
	const bin = join(dirname(require.resolve("concurrently/package.json")), "dist", "bin", "index.js");
	const child = spawn(
		process.execPath,
		[bin, "pnpm --filter ./apps/backend dev", "pnpm --filter ./apps/frontend dev"],
		{ cwd: ROOT, stdio: "inherit", env: { ...process.env, BACKEND_PORT: String(port) } },
	);
	child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
