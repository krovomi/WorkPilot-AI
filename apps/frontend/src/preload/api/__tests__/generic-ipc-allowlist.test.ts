/**
 * The generic passthrough (`invoke`, `send`, `on`, `onIpcEvent`) used to
 * forward any channel name to `ipcRenderer`, so the renderer could reach every
 * `ipcMain` handler of the main process. It now forwards only the channels
 * listed in `generic-ipc-api.ts`. These tests pin that down at runtime, where
 * the renderer's types no longer exist:
 *
 *   - a channel off the list never reaches `ipcRenderer`, whatever its shape;
 *   - no method of the composed bridge lets the caller choose a channel;
 *   - every listed channel is one the main process actually serves, and one
 *     no typed method covers already — the list only ever shrinks.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ipcRenderer } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { createElectronAPI, type ElectronAPI } from "..";
import {
	createGenericIpcAPI,
	GENERIC_INVOKE_CHANNELS,
	GENERIC_LISTEN_CHANNELS,
	GENERIC_SEND_CHANNELS,
} from "../modules/generic-ipc-api";

const SRC_DIR = path.resolve(import.meta.dirname, "../../..");

const noop = (): void => undefined;

/** A real main-process channel that no renderer page needs to call blindly. */
const UNLISTED = IPC_CHANNELS.PROJECT_REMOVE;

/** Everything a hostile caller might pass where a channel is expected. */
const HOSTILE_CHANNELS: unknown[] = [
	UNLISTED,
	"",
	"__proto__",
	"constructor",
	"hasOwnProperty",
	` ${GENERIC_INVOKE_CHANNELS[0]}`,
	GENERIC_INVOKE_CHANNELS[0].toUpperCase(),
	{ toString: () => GENERIC_INVOKE_CHANNELS[0] },
	[GENERIC_INVOKE_CHANNELS[0]],
	undefined,
	null,
	42,
];

type Spied = "invoke" | "send" | "on" | "once" | "sendSync" | "postMessage";
const SPIED: Spied[] = ["invoke", "send", "on", "once", "sendSync", "postMessage"];

/** Every channel handed to `ipcRenderer` during a test, whatever the method. */
let reached: { method: Spied; channel: unknown }[] = [];
const renderer = ipcRenderer as unknown as Record<string, unknown>;
const originals = new Map<Spied, unknown>();

beforeEach(() => {
	reached = [];
	for (const method of SPIED) {
		originals.set(method, renderer[method]);
		renderer[method] = vi.fn((channel: unknown) => {
			reached.push({ method, channel });
			return method === "invoke" ? Promise.resolve(undefined) : undefined;
		});
	}
});

afterEach(() => {
	for (const [method, original] of originals) renderer[method] = original;
	originals.clear();
});

function sources(dir: string): { file: string; source: string }[] {
	const out: { file: string; source: string }[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__") continue;
			out.push(...sources(full));
		} else if (
			/\.tsx?$/.test(entry.name) &&
			!/\.(test|spec)\.tsx?$/.test(entry.name)
		) {
			out.push({ file: path.relative(SRC_DIR, full), source: readFileSync(full, "utf-8") });
		}
	}
	return out;
}

const CONSTANT_NAMES = new Map<string, string[]>();
for (const [name, value] of Object.entries(IPC_CHANNELS)) {
	CONSTANT_NAMES.set(value, [...(CONSTANT_NAMES.get(value) ?? []), name]);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the channel spelled either as a string literal or as its constant. */
function channelPattern(channel: string): string {
	const spellings = [
		`["'\`]${escapeRegExp(channel)}["'\`]`,
		...(CONSTANT_NAMES.get(channel) ?? []).map(
			(name) => `IPC_CHANNELS\\.${name}\\b`,
		),
	];
	return `(?:${spellings.join("|")})`;
}

describe("generic IPC passthrough", () => {
	const api = createGenericIpcAPI();

	it("forwards a listed channel to ipcRenderer", async () => {
		await api.invoke(GENERIC_INVOKE_CHANNELS[0], "arg");
		api.send(GENERIC_SEND_CHANNELS[0], "arg");
		const unsubscribe = api.onIpcEvent(GENERIC_LISTEN_CHANNELS[0], noop);
		unsubscribe();
		api.on(GENERIC_LISTEN_CHANNELS[0], noop)();

		expect(reached).toEqual([
			{ method: "invoke", channel: GENERIC_INVOKE_CHANNELS[0] },
			{ method: "send", channel: GENERIC_SEND_CHANNELS[0] },
			{ method: "on", channel: GENERIC_LISTEN_CHANNELS[0] },
			{ method: "on", channel: GENERIC_LISTEN_CHANNELS[0] },
		]);
	});

	it.each(HOSTILE_CHANNELS.map((channel) => [channel]))(
		"refuses %j on every direction without reaching ipcRenderer",
		async (channel) => {
			const anyChannel = channel as never;

			await expect(api.invoke(anyChannel, "arg")).rejects.toThrow(/refused/);
			expect(() => api.send(anyChannel, "arg")).toThrow(/refused/);
			expect(() => api.on(anyChannel, noop)).toThrow(/refused/);
			expect(() => api.onIpcEvent(anyChannel, noop)).toThrow(/refused/);

			expect(reached).toEqual([]);
		},
	);

	it("does not let one direction borrow another's list", async () => {
		await expect(
			api.invoke(GENERIC_SEND_CHANNELS[0] as never),
		).rejects.toThrow(/refused/);
		expect(() => api.send(GENERIC_INVOKE_CHANNELS[0] as never)).toThrow(
			/refused/,
		);
		expect(() =>
			api.onIpcEvent(GENERIC_INVOKE_CHANNELS[0] as never, noop),
		).toThrow(/refused/);

		expect(reached).toEqual([]);
	});

	it("is the passthrough the composed bridge exposes", async () => {
		const bridge = createElectronAPI();
		reached = [];

		await expect(bridge.invoke(UNLISTED as never)).rejects.toThrow(/refused/);
		expect(() => bridge.send(UNLISTED as never)).toThrow(/refused/);
		expect(() => bridge.on(UNLISTED as never, noop)).toThrow(/refused/);
		expect(() => bridge.onIpcEvent(UNLISTED as never, noop)).toThrow(
			/refused/,
		);

		expect(reached).toEqual([]);
	});
});

describe("bridge types", () => {
	// These assertions are checked by `pnpm run typecheck`: if `ElectronAPI`
	// regains an index signature, or the passthrough a `string` channel, the
	// directives below go unused and the typecheck fails.
	it("reject an unknown member and an unlisted channel at compile time", async () => {
		const bridge = createElectronAPI() as ElectronAPI;
		reached = [];

		// @ts-expect-error — not a bridge method
		expect(bridge.notABridgeMethod).toBeUndefined();
		// @ts-expect-error — not on the invoke list
		await expect(bridge.invoke(UNLISTED)).rejects.toThrow(/refused/);

		expect(reached).toEqual([]);
	});
});

describe("composed bridge", () => {
	const ROGUE = "rogue:channel-chosen-by-the-caller";
	const rogueObject = new Proxy(
		{},
		{ get: (_target, key) => (key === "then" ? undefined : ROGUE) },
	);

	function methods(
		value: object,
		prefix: string,
	): { name: string; fn: (...args: unknown[]) => unknown }[] {
		return Object.entries(value).flatMap(([key, member]) => {
			if (typeof member === "function") {
				return [{ name: `${prefix}${key}`, fn: member }];
			}
			if (member && typeof member === "object") {
				return methods(member, `${prefix}${key}.`);
			}
			return [];
		});
	}

	it("never lets a caller choose the channel", async () => {
		const bridge = methods(createElectronAPI(), "");
		expect(bridge.length).toBeGreaterThan(500);
		reached = [];

		const offenders = new Set<string>();
		for (const args of [Array(6).fill(ROGUE), Array(6).fill(rogueObject)]) {
			for (const { name, fn } of bridge) {
				const before = reached.length;
				try {
					const result = fn(...args);
					if (result instanceof Promise) await result.catch(noop);
				} catch {
					// A refusal or a type error: neither reaches ipcRenderer.
				}
				for (const { channel } of reached.slice(before)) {
					if (typeof channel !== "string" || channel.includes(ROGUE)) {
						offenders.add(name);
					}
				}
			}
		}

		expect(reached.length).toBeGreaterThan(500);
		expect([...offenders]).toEqual([]);
	});
});

describe("generic channel lists", () => {
	const lists = {
		invoke: GENERIC_INVOKE_CHANNELS,
		send: GENERIC_SEND_CHANNELS,
		listen: GENERIC_LISTEN_CHANNELS,
	};

	it("hold no duplicates", () => {
		for (const list of Object.values(lists)) {
			expect(new Set(list).size).toBe(list.length);
		}
	});

	it("name channels the main process serves", () => {
		const main = sources(path.join(SRC_DIR, "main"))
			.map(({ source }) => source)
			.join("\n");
		const served = {
			invoke: (ch: string) => `ipcMain\\.handle\\(\\s*${channelPattern(ch)}`,
			send: (ch: string) => `ipcMain\\.on\\(\\s*${channelPattern(ch)}`,
			listen: (ch: string) => `\\.send\\(\\s*${channelPattern(ch)}`,
		};

		const unserved = Object.entries(lists).flatMap(([direction, list]) =>
			list.filter(
				(channel) =>
					!new RegExp(served[direction as keyof typeof served](channel)).test(
						main,
					),
			),
		);

		expect(unserved).toEqual([]);
	});

	it("name no channel a typed preload method already covers", () => {
		const typed = sources(path.join(SRC_DIR, "preload")).filter(
			({ file }) => !file.endsWith("generic-ipc-api.ts"),
		);
		const covered = Object.values(lists)
			.flat()
			.flatMap((channel) =>
				typed
					.filter(({ source }) =>
						new RegExp(channelPattern(channel)).test(source),
					)
					.map(({ file }) => `${channel} (${file})`),
			);

		expect(covered).toEqual([]);
	});
});
