/**
 * Every channel the preload invokes must have someone listening in main — and
 * so must every channel the renderer names through the generic
 * `electronAPI.invoke/send` bridge.
 *
 * Five preload methods — `scanOllamaModels`, `downloadOllamaModel`,
 * `submitOAuthCode`, `initializeClaudeProfile`, `getAzureDevOpsProjects` —
 * invoked channels that no `ipcMain` call had ever registered. Nothing failed at
 * build time: `ipcRenderer.invoke` on an unregistered channel only rejects at
 * run time with "No handler registered for …", and the handlers had been
 * deleted (or never written) on the main side while the bridge kept offering
 * them to the renderer. `handler-registration.test.ts` could not see it either:
 * it checks that handler *modules* are wired, not that what the preload asks
 * for exists.
 *
 * Like that test, this one reads the sources rather than the runtime. A channel
 * is collected from the call that uses it — `ipcRenderer.invoke/send/sendSync`
 * and the `invokeIpc`/`sendIpc` helpers on the preload side, `ipcMain.handle/
 * handleOnce/on/once` anywhere under `src/main` on the other — and resolved
 * from `IPC_CHANNELS`, a string literal, or a file-local `const` holding one.
 * Comments are blanked first: a JSDoc example of `ipcMain.handle(…)` is not a
 * handler. An argument that cannot be resolved fails the test instead of being
 * skipped, so a new way of naming a channel cannot quietly opt out of it.
 *
 * Existing is not enough: a handler in a file nothing imports never runs. Every
 * handled channel must therefore have at least one handler in a file reachable
 * from the main entry point through the import graph. Whether the registrar
 * *inside* that file is called is `handler-registration.test.ts`'s question.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "..", "..");
const MAIN_DIR = path.join(SRC, "main");
const MAIN_ENTRY = path.join(MAIN_DIR, "index.ts");
const PRELOAD_DIR = path.join(SRC, "preload");
const RENDERER_DIR = path.join(SRC, "renderer");
const IPC_CONSTANTS = path.join(SRC, "shared", "constants", "ipc.ts");

/**
 * Channels whose handler exists but is never registered, each with the change
 * that will register it. An entry that no longer fails is reported as stale:
 * the list only shrinks.
 */
const UNREGISTERED_ALLOWLIST: Record<string, string> = {};

/**
 * Files whose IPC calls take the channel as a parameter: they forward whatever
 * their callers name, and it is the callers that are checked.
 */
const DYNAMIC_FORWARDERS = new Set([
	// `invokeIpc` / `sendIpc` themselves — every call to them is checked.
	"preload/api/modules/ipc-utils.ts",
	// `electronAPI.invoke(channel)` / `.send(channel)`: the renderer's generic
	// escape hatch, which picks its channel at run time.
	"preload/api/modules/generic-ipc-api.ts",
	// `createIpcHandler` / `createIpcListener`: unused today. Whoever calls them
	// will find their channel reported missing here, and must teach this test to
	// read that call rather than add the channel to an allowlist.
	"main/electron-utils.ts",
]);

const PRELOAD_CALL =
	/(?<![\w$])(?<!function\s+)(?:ipcRenderer\s*\.\s*(?:invoke|send|sendSync)|invokeIpc|sendIpc)\b/g;
/**
 * `electronAPI.invoke("…")` / `.send("…")`: the generic bridge the renderer
 * names a channel through itself. The preload forwards whatever it is given, so
 * these calls are checked where the channel is written — in the renderer.
 */
const RENDERER_CALL = /(?<![\w$])electronAPI\s*\??\.\s*(?:invoke|send)\b/g;
const MAIN_REGISTRATION =
	/(?<![\w$])ipcMain\s*\.\s*(?:handle|handleOnce|on|once)\b/g;

interface ChannelUse {
	channel: string;
	file: string;
	line: number;
}

interface Unresolved {
	argument: string;
	file: string;
	line: number;
}

/** Every `.ts` (and, when asked, `.tsx`) source under `dir`, tests excluded. */
function sourceFiles(dir: string, withTsx = false): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			out.push(...sourceFiles(full, withTsx));
		} else if (
			(entry.name.endsWith(".ts") ||
				(withTsx && entry.name.endsWith(".tsx"))) &&
			!/\.test\.tsx?$/.test(entry.name) &&
			!entry.name.endsWith(".d.ts")
		) {
			out.push(full);
		}
	}
	return out;
}

const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS =
	/(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * The source with every comment replaced by spaces, newlines kept so that
 * offsets still map to the same line. Strings, template literals (with their
 * `${}` holes) and regular-expression literals are skipped over, so a `"//"`
 * or a `"src/**\/*.ts"` glob is not mistaken for a comment.
 */
function blankComments(source: string): string {
	const out = source.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
	};
	// Each entry is the brace depth at which a `${` hole closes back into its
	// template literal.
	const templateHoles: number[] = [];
	let braceDepth = 0;
	let lastSignificant = "";
	let i = 0;

	const skipQuoted = (quote: string): void => {
		i++;
		while (i < source.length && source[i] !== quote) {
			if (source[i] === "\\") i++;
			else if (source[i] === "\n" && quote !== "`") break;
			i++;
		}
		i++;
	};

	// Scans template text from `i` (just after a backtick or a closing hole) to
	// the closing backtick, or into the next `${` hole.
	const scanTemplate = (): void => {
		while (i < source.length) {
			const c = source[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === "`") {
				i++;
				lastSignificant = "`";
				return;
			}
			if (c === "$" && source[i + 1] === "{") {
				i += 2;
				templateHoles.push(braceDepth);
				braceDepth++;
				lastSignificant = "{";
				return;
			}
			i++;
		}
	};

	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			const stop = end === -1 ? source.length : end;
			blank(i, stop);
			i = stop;
		} else if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end === -1 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
		} else if (c === '"' || c === "'") {
			skipQuoted(c);
			lastSignificant = c;
		} else if (c === "`") {
			i++;
			scanTemplate();
		} else if (
			c === "/" &&
			(lastSignificant === "" ||
				REGEX_PRECEDERS.has(lastSignificant) ||
				REGEX_KEYWORDS.test(source.slice(Math.max(0, i - 12), i).trimEnd()))
		) {
			// A regular-expression literal: up to the unescaped `/` outside a
			// character class.
			let inClass = false;
			i++;
			while (i < source.length && source[i] !== "\n") {
				const r = source[i];
				if (r === "\\") i++;
				else if (r === "[") inClass = true;
				else if (r === "]") inClass = false;
				else if (r === "/" && !inClass) break;
				i++;
			}
			i++;
			lastSignificant = "/re/";
		} else {
			if (c === "{") braceDepth++;
			else if (c === "}") {
				braceDepth--;
				if (
					templateHoles.length > 0 &&
					templateHoles[templateHoles.length - 1] === braceDepth
				) {
					templateHoles.pop();
					i++;
					scanTemplate();
					continue;
				}
			}
			if (!/\s/.test(c)) lastSignificant = c;
			i++;
		}
	}
	return out.join("");
}

function lineAt(source: string, offset: number): number {
	let line = 1;
	for (let k = 0; k < offset; k++) if (source[k] === "\n") line++;
	return line;
}

/**
 * The first argument of the call whose callee ends at `from`, or `null` when
 * what follows is not a call (an import list, a re-export). Type arguments are
 * skipped, nested and with `=>` in them.
 */
function firstArgument(source: string, from: number): string | null {
	let i = from;
	while (/\s/.test(source[i] ?? "")) i++;
	if (source[i] === "<") {
		let depth = 0;
		for (; i < source.length; i++) {
			const c = source[i];
			if (c === '"' || c === "'") {
				const close = source.indexOf(c, i + 1);
				i = close === -1 ? source.length : close;
			} else if (c === "<") depth++;
			else if (c === ">" && source[i - 1] !== "=") {
				depth--;
				if (depth === 0) break;
			}
		}
		i++;
		while (/\s/.test(source[i] ?? "")) i++;
	}
	if (source[i] !== "(") return null;
	i++;
	const start = i;
	let depth = 0;
	for (; i < source.length; i++) {
		const c = source[i];
		if (c === '"' || c === "'" || c === "`") {
			let k = i + 1;
			while (k < source.length && source[k] !== c) k += source[k] === "\\" ? 2 : 1;
			i = k;
		} else if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) break;
			depth--;
		} else if (c === "," && depth === 0) break;
	}
	return source.slice(start, i).trim();
}

/**
 * The string constants a file declares at any level: `const NAME = "value"`
 * and the entries of `const NAME = { KEY: "value", … }` (read as `NAME.KEY`).
 * A name declared twice with different values is ambiguous and left out.
 */
function localConstants(source: string): Map<string, string> {
	const values = new Map<string, Set<string>>();
	const add = (name: string, value: string) => {
		values.set(name, (values.get(name) ?? new Set()).add(value));
	};
	for (const m of source.matchAll(
		/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(["'])([^"'\n]*)\2/g,
	)) {
		add(m[1], m[3]);
	}
	for (const m of source.matchAll(
		/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^{}]*)\}/g,
	)) {
		for (const entry of m[2].matchAll(
			/([A-Za-z_$][\w$]*)\s*:\s*(["'])([^"'\n]*)\2/g,
		)) {
			add(`${m[1]}.${entry[1]}`, entry[3]);
		}
	}
	const unique = new Map<string, string>();
	for (const [name, set] of values) {
		if (set.size === 1) unique.set(name, [...set][0]);
	}
	return unique;
}

/** `KEY: "value"` entries of `IPC_CHANNELS`, including those wrapped onto a second line. */
function ipcChannelConstants(): Map<string, string> {
	const source = blankComments(readFileSync(IPC_CONSTANTS, "utf-8"));
	const start = source.indexOf("export const IPC_CHANNELS = {");
	const end = source.indexOf("} as const", start);
	const body = source.slice(start, end);
	const out = new Map<string, string>();
	for (const m of body.matchAll(/\b([A-Z][A-Z0-9_]*)\s*:\s*"([^"]*)"/g)) {
		out.set(m[1], m[2]);
	}
	return out;
}

function resolveChannel(
	argument: string,
	locals: Map<string, string>,
	constants: Map<string, string>,
): string | null {
	const constant = /^IPC_CHANNELS\.([A-Z][A-Z0-9_]*)$/.exec(argument);
	if (constant) return constants.get(constant[1]) ?? null;
	const literal = /^(["'`])([^"'`]*)\1$/.exec(argument);
	if (literal) return literal[2].includes("${") ? null : literal[2];
	return locals.get(argument) ?? null;
}

function collect(
	files: string[],
	pattern: RegExp,
	constants: Map<string, string>,
): { uses: ChannelUse[]; unresolved: Unresolved[] } {
	const uses: ChannelUse[] = [];
	const unresolved: Unresolved[] = [];
	for (const full of files) {
		const file = path.relative(SRC, full).split(path.sep).join("/");
		const source = blankComments(readFileSync(full, "utf-8"));
		const locals = localConstants(source);
		for (const m of source.matchAll(pattern)) {
			const offset = m.index ?? 0;
			const argument = firstArgument(source, offset + m[0].length);
			if (argument === null) continue;
			const line = lineAt(source, offset);
			const channel = resolveChannel(argument, locals, constants);
			if (channel !== null) uses.push({ channel, file, line });
			else if (!DYNAMIC_FORWARDERS.has(file)) {
				unresolved.push({ argument, file, line });
			}
		}
	}
	return { uses, unresolved };
}

/** Relative import specifiers of a file, resolved to the `.ts` they load. */
function runtimeImports(full: string, source: string): string[] {
	const specifiers = [
		...source.matchAll(
			/^\s*(?:import|export)\s+(?!type\b)[^"'`;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/gm,
		),
		...source.matchAll(/^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gm),
		...source.matchAll(/\b(?:import|require)\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
	].map((m) => m[1]);
	const out: string[] = [];
	for (const specifier of specifiers) {
		const base = path.resolve(path.dirname(full), specifier.replace(/\.js$/, ""));
		const candidate = [`${base}.ts`, path.join(base, "index.ts"), base].find(
			(p) => existsSync(p) && statSync(p).isFile(),
		);
		if (candidate) out.push(candidate);
	}
	return out;
}

/** Every file under `src/main` the entry point loads, directly or not. */
function reachableFromMainEntry(): Set<string> {
	const seen = new Set<string>();
	const queue = [MAIN_ENTRY];
	while (queue.length > 0) {
		const full = queue.pop() as string;
		if (seen.has(full)) continue;
		seen.add(full);
		if (!full.startsWith(MAIN_DIR)) continue;
		const source = blankComments(readFileSync(full, "utf-8"));
		queue.push(...runtimeImports(full, source));
	}
	return new Set(
		[...seen].map((full) => path.relative(SRC, full).split(path.sep).join("/")),
	);
}

const where = (use: { file: string; line: number }) => `${use.file}:${use.line}`;

describe("IPC channel parity (preload and renderer → main)", () => {
	const constants = ipcChannelConstants();
	const preload = collect(sourceFiles(PRELOAD_DIR), PRELOAD_CALL, constants);
	const renderer = collect(
		sourceFiles(RENDERER_DIR, true),
		RENDERER_CALL,
		constants,
	);
	const main = collect(sourceFiles(MAIN_DIR), MAIN_REGISTRATION, constants);
	const reachable = reachableFromMainEntry();

	const handlersOf = new Map<string, ChannelUse[]>();
	for (const use of main.uses) {
		handlersOf.set(use.channel, [...(handlersOf.get(use.channel) ?? []), use]);
	}
	const invoked = new Map<string, ChannelUse[]>();
	for (const use of [...preload.uses, ...renderer.uses]) {
		invoked.set(use.channel, [...(invoked.get(use.channel) ?? []), use]);
	}

	it("finds the channels on both sides", () => {
		// A refactor that renames the helpers or moves the files must fail here
		// rather than turn the checks below into vacuous passes.
		expect(constants.size).toBeGreaterThan(500);
		expect(invoked.size).toBeGreaterThan(400);
		expect(renderer.uses.length).toBeGreaterThan(50);
		expect(handlersOf.size).toBeGreaterThan(500);
		expect(reachable.size).toBeGreaterThan(100);
	});

	it("resolves the channel of every IPC call", () => {
		const report = (u: Unresolved) => `${where(u)}  ${u.argument}`;
		expect(preload.unresolved.map(report), "preload calls").toEqual([]);
		expect(renderer.unresolved.map(report), "renderer generic calls").toEqual(
			[],
		);
		expect(main.unresolved.map(report), "main registrations").toEqual([]);
	});

	it("ignores IPC calls written in comments", () => {
		// `project-middleware.ts` documents its helpers with JSDoc examples
		// calling `ipcMain.handle('channel', …)`.
		const middleware = readFileSync(
			path.join(MAIN_DIR, "ipc-handlers", "github", "utils", "project-middleware.ts"),
			"utf-8",
		);
		expect(middleware).toContain("ipcMain.handle('channel'");
		expect(handlersOf.has("channel")).toBe(false);
	});

	it("has a main-process handler for every channel the preload or renderer invokes", () => {
		const missing = [...invoked]
			.filter(([channel]) => !handlersOf.has(channel))
			.map(([channel, uses]) => `${channel}  (${uses.map(where).join(", ")})`)
			.sort();

		expect(
			missing,
			"invoked by the preload or the renderer, handled by nothing in src/main",
		).toEqual([]);
	});

	const unregistered = [...invoked]
		.filter(([channel]) => handlersOf.has(channel))
		.filter(([channel]) =>
			(handlersOf.get(channel) ?? []).every((h) => !reachable.has(h.file)),
		);

	it("handles every invoked channel in a file the main process loads", () => {
		const missing = unregistered
			.filter(([channel]) => !(channel in UNREGISTERED_ALLOWLIST))
			.map(
				([channel]) =>
					`${channel}  (handled only in ${(handlersOf.get(channel) ?? [])
						.map(where)
						.join(", ")})`,
			)
			.sort();

		expect(
			missing,
			`handled only in files nothing imports from ${path.relative(SRC, MAIN_ENTRY)}`,
		).toEqual([]);
	});

	it("keeps the allowlist down to channels that still need it", () => {
		const stillNeeded = new Set(unregistered.map(([channel]) => channel));
		const stale = Object.keys(UNREGISTERED_ALLOWLIST)
			.filter((channel) => !stillNeeded.has(channel))
			.sort();

		expect(stale, "registered now — remove from UNREGISTERED_ALLOWLIST").toEqual(
			[],
		);
	});
});
