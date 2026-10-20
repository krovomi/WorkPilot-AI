/**
 * A service event reaches the renderer only if three things line up, and for
 * six features none of them did at once:
 *
 * 1. The forwarder is called. `setupAutoRefactorEventForwarding` was exported
 *    and never wired, so the preload subscribed to five channels nobody sent —
 *    and the service's `"error"` events, having no listener, threw.
 * 2. The forwarder can find the window. Code Playground, Performance Profiler,
 *    Code Migration, Auto-Refactor, Architecture Visualizer and Documentation
 *    Agent read `global.mainWindow`, which nothing ever assigned (the only
 *    write was `= null` on close), so every `webContents.send` was skipped.
 *    The window is reached through `getMainWindow`, like everywhere else.
 * 3. The channel it sends is the channel the preload listens on. Three
 *    forwarders sent `stream-chunk`, `task-progress` and
 *    `implementation-complete` to preloads listening on `streamChunk`,
 *    `taskProgress` and `implementationComplete`.
 *
 * Each defect alone was enough to make the feature silent, and none raised
 * anything: an event sent to no listener, or not sent at all, is not an error.
 * Like `handler-registration.test.ts`, this reads the sources — the defects are
 * missing or mismatched lines, which the files themselves can answer for.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";

const HANDLERS_DIR = path.resolve(import.meta.dirname, "..");
const MAIN_DIR = path.resolve(HANDLERS_DIR, "..");
const PRELOAD_DIR = path.resolve(MAIN_DIR, "..", "preload");
const INDEX = path.join(HANDLERS_DIR, "index.ts");

const CHANNELS = IPC_CHANNELS as Record<string, string>;

/** Every non-test `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			out.push(...sourceFiles(full));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * The channel a call names: a string literal, or an `IPC_CHANNELS.X` resolved
 * to its value. `undefined` for an `IPC_CHANNELS` key that does not exist.
 */
function channelOf(match: RegExpMatchArray): string | undefined {
	const [, doubleQuoted, singleQuoted, constant] = match;
	if (constant !== undefined) return CHANNELS[constant];
	return doubleQuoted ?? singleQuoted;
}

const CHANNEL_ARG = String.raw`(?:"([^"]+)"|'([^']+)'|IPC_CHANNELS\.(\w+))`;

/** `webContents.send(…)` and a local `send(…)` helper alike. */
const SEND = new RegExp(String.raw`\bsend\s*\(\s*${CHANNEL_ARG}`, "g");

/** `createIpcListener(…)`, `createIpcListener<[T]>(…)`, `ipcRenderer.on(…)` */
const LISTENER = String.raw`(?:\bcreateIpcListener|\bipcRenderer\s*\.\s*(?:on|once))`;
const GENERICS = String.raw`(?:\s*<[^()]*?>)?`;
const LISTEN = new RegExp(
	String.raw`${LISTENER}${GENERICS}\s*\(\s*${CHANNEL_ARG}`,
	"g",
);

interface Forwarder {
	name: string;
	file: string;
	body: string;
}

/**
 * Each `export function setupFooEventForwarding(` and its body, up to the
 * next export.
 */
function forwarders(): Forwarder[] {
	const out: Forwarder[] = [];
	for (const file of sourceFiles(HANDLERS_DIR)) {
		const source = readFileSync(file, "utf-8");
		for (const m of source.matchAll(
			/export function (setup\w*EventForwarding)\s*\(/g,
		)) {
			const start = m.index ?? 0;
			const next = source.indexOf("\nexport ", start + 1);
			out.push({
				name: m[1],
				file: path.relative(HANDLERS_DIR, file),
				body: source.slice(start, next === -1 ? undefined : next),
			});
		}
	}
	return out;
}

describe("main → renderer event forwarding", () => {
	const all = forwarders();

	it("finds the forwarders", () => {
		// A rename should fail here loudly rather than turn every check below
		// into a vacuous pass.
		expect(all.length).toBeGreaterThan(5);
	});

	it("calls every exported setup*EventForwarding from setupIpcHandlers", () => {
		const index = readFileSync(INDEX, "utf-8");
		const setupBody = index.slice(
			index.indexOf("export function setupIpcHandlers"),
		);

		const isCalled = (name: string): boolean =>
			new RegExp(String.raw`\b${name}\s*\(`).test(setupBody);
		const unwired = all
			.filter(({ name }) => !isCalled(name))
			.map(({ name }) => name)
			.sort();

		expect(unwired).toEqual([]);
	});

	it("never reaches the window through a global", () => {
		const GLOBAL_WINDOW = /\bglobal(?:This)?\s*\.\s*mainWindow\b/;
		const offenders = sourceFiles(MAIN_DIR)
			.filter((file) => GLOBAL_WINDOW.test(readFileSync(file, "utf-8")))
			.map((file) => path.relative(MAIN_DIR, file))
			.sort();

		expect(offenders).toEqual([]);
	});

	it("sends only channels the preload listens on", () => {
		const listened = new Set<string>();
		for (const file of sourceFiles(PRELOAD_DIR)) {
			for (const m of readFileSync(file, "utf-8").matchAll(LISTEN)) {
				const channel = channelOf(m);
				if (channel) listened.add(channel);
			}
		}
		// The preload subscribes to hundreds of channels; finding none means the
		// pattern stopped matching, not that every forwarder is broken.
		expect(listened.size).toBeGreaterThan(50);

		const problems: string[] = [];
		for (const { name, file, body } of all) {
			const sent = [...body.matchAll(SEND)];
			// A forwarder that sends nothing is a stub registered for show.
			if (sent.length === 0) problems.push(`${file} ${name}: sends nothing`);
			for (const m of sent) {
				const channel = channelOf(m);
				if (channel === undefined) {
					problems.push(`${file} ${name}: unknown IPC_CHANNELS.${m[3]}`);
				} else if (!listened.has(channel)) {
					problems.push(`${file} ${name}: nobody listens on "${channel}"`);
				}
			}
		}

		expect(problems.sort()).toEqual([]);
	});
});
