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
	/** The call names the channel as `IPC_CHANNELS.X`, not by its string. */
	named: boolean;
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
 * The argument at `index` of the call whose callee ends at `from`, or `null`
 * when what follows is not a call (an import list, a re-export) or has fewer
 * arguments. Type arguments are skipped, nested and with `=>` in them.
 */
function nthArgument(
	source: string,
	from: number,
	index: number,
): string | null {
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
	let start = i;
	let depth = 0;
	let seen = 0;
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
		} else if (c === "," && depth === 0) {
			if (seen === index) break;
			seen++;
			start = i + 1;
		}
	}
	return seen === index ? source.slice(start, i).trim() : null;
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

const isNamed = (argument: string) =>
	/^IPC_CHANNELS\.[A-Z][A-Z0-9_]*$/.test(argument);

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
	argumentIndex: (callee: string) => number = () => 0,
): { uses: ChannelUse[]; unresolved: Unresolved[] } {
	const uses: ChannelUse[] = [];
	const unresolved: Unresolved[] = [];
	for (const full of files) {
		const file = path.relative(SRC, full).split(path.sep).join("/");
		const source = blankComments(readFileSync(full, "utf-8"));
		const locals = localConstants(source);
		for (const m of source.matchAll(pattern)) {
			const offset = m.index ?? 0;
			const argument = nthArgument(
				source,
				offset + m[0].length,
				argumentIndex(m[0]),
			);
			if (argument === null) continue;
			const line = lineAt(source, offset);
			const channel = resolveChannel(argument, locals, constants);
			if (channel !== null) {
				uses.push({ channel, file, line, named: isNamed(argument) });
			}
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


/**
 * Main → renderer, the other way round. A channel the main process sends on
 * with nobody listening in the preload is an event the renderer never sees,
 * and a listener with no sender waits forever. Neither fails anywhere else.
 *
 * Sends are read from `webContents.send` and `event.sender.send`; listeners
 * from `ipcRenderer.on/once` and `createIpcListener`. Most sends go through a
 * small helper that takes the channel as a parameter (`broadcast`,
 * `safeSendToRenderer`, `createProgressSender`…): such a helper is found from
 * the send it wraps, and its own calls are read in its place, in its file or,
 * when it is exported, in every file of the same side.
 */
/**
 * Channels main sends on that nothing hears yet, each with the decision that
 * removes it (lot M8, which settles the views without tests). An entry that is
 * heard, or no longer sent, is reported as stale: the list only shrinks.
 */
const UNHEARD_ALLOWLIST: Record<string, string> = {
	"github:triage:progress":
		"the GitHub triage handlers have no preload caller at all (M8)",
	"github:triage:complete":
		"the GitHub triage handlers have no preload caller at all (M8)",
	"github:triage:error":
		"the GitHub triage handlers have no preload caller at all (M8)",
};

const MAIN_SEND = /(?<![\w$])(?:webContents|sender)\s*\.\s*send\b/g;
const PRELOAD_LISTEN =
	/(?<![\w$])(?:ipcRenderer\s*\.\s*(?:on|once)|createIpcListener)\b/g;

interface Forwarder {
	name: string;
	index: number;
	/** When the channel is a property of that parameter: its name. */
	key?: string;
	file: string;
	exported: boolean;
}

/** The text between the parenthesis at `open` and its match. */
function balancedParens(source: string, open: number): string {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const c = source[i];
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return source.slice(open + 1, i);
		}
	}
	return "";
}

/** Parameter names of a parameter list, rest parameters included. */
function parameterNames(list: string): string[] {
	const names: string[] = [];
	const push = (parameter: string) => {
		const name = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(parameter);
		if (name) names.push(name[1]);
	};
	let depth = 0;
	let start = 0;
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
		else if (c === ")" || c === "]" || c === "}") depth--;
		else if (c === ">" && list[i - 1] !== "=") depth--;
		else if (c === "," && depth === 0) {
			push(list.slice(start, i));
			start = i + 1;
		}
	}
	push(list.slice(start));
	return names;
}

/**
 * The closest function before `offset` that has the parameter `argument`
 * names (`channel`, or `channels` for `channels.progress`): the helper whose
 * caller names the channel.
 */
function enclosingForwarder(
	source: string,
	offset: number,
	argument: string,
	file: string,
): Forwarder | null {
	const parts = /^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?$/.exec(argument);
	if (!parts) return null;
	const [, param, key] = parts;
	const definitions = [
		...source
			.slice(0, offset)
			.matchAll(
				/(export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^(]*>)?)\(/g,
			),
	];
	for (let k = definitions.length - 1; k >= 0; k--) {
		const m = definitions[k];
		const open = (m.index ?? 0) + m[0].length - 1;
		const index = parameterNames(balancedParens(source, open)).indexOf(param);
		if (index !== -1) {
			return {
				name: m[2] ?? m[3],
				index,
				key,
				file,
				exported: Boolean(m[1]),
			};
		}
	}
	return null;
}

/** The value of the closest `const name = "…"` before `offset`. */
function closestConstant(
	source: string,
	offset: number,
	name: string,
): string | null {
	const found = [
		...source
			.slice(0, offset)
			.matchAll(
				new RegExp(`\\bconst\\s+${name}\\s*(?::\\s*string\\s*)?=\\s*(["'])([^"'\\n]*)\\1`, "g"),
			),
	];
	return found.length > 0 ? found[found.length - 1][2] : null;
}

/** The value written for `key` in the object literal `text`, or `null`. */
function propertyOf(text: string, key: string): string | null {
	if (!text.startsWith("{")) return null;
	const m = new RegExp(`(?:^|[{,\\s])${key}\\s*:\\s*([^,}\\s]+)`).exec(text);
	return m ? m[1] : null;
}

/**
 * Channel uses of the calls `pattern` finds in `files`, then of the calls to
 * every helper that forwards its channel parameter to one of them.
 */
function collectThroughForwarders(
	files: string[],
	pattern: RegExp,
	constants: Map<string, string>,
): { uses: ChannelUse[]; unresolved: Unresolved[]; forwarders: Forwarder[] } {
	const sources = new Map(
		files.map((full) => [
			path.relative(SRC, full).split(path.sep).join("/"),
			blankComments(readFileSync(full, "utf-8")),
		]),
	);
	const uses: ChannelUse[] = [];
	const unresolved: Unresolved[] = [];
	const forwarders: Forwarder[] = [];
	const known = new Set<string>();

	const scan = (
		file: string,
		callee: RegExp,
		index: number,
		key?: string,
	): void => {
		const source = sources.get(file) as string;
		const locals = localConstants(source);
		for (const m of source.matchAll(callee)) {
			const offset = m.index ?? 0;
			const raw = nthArgument(source, offset + m[0].length, index);
			const argument =
				raw !== null && key !== undefined ? propertyOf(raw, key) : raw;
			if (argument === null) continue;
			const line = lineAt(source, offset);
			const channel =
				resolveChannel(argument, locals, constants) ??
				(/^[A-Za-z_$][\w$]*$/.test(argument)
					? closestConstant(source, offset, argument)
					: null);
			if (channel !== null) {
				uses.push({ channel, file, line, named: isNamed(argument) });
				continue;
			}
			if (DYNAMIC_FORWARDERS.has(file)) continue;
			const forwarder = enclosingForwarder(source, offset, argument, file);
			if (!forwarder) {
				unresolved.push({ argument, file, line });
				continue;
			}
			const id = `${forwarder.file}#${forwarder.name}#${forwarder.index}#${forwarder.key}`;
			if (known.has(id)) continue;
			known.add(id);
			forwarders.push(forwarder);
			const call = new RegExp(
				`(?<![\\w$.])(?<!function\\s+)${forwarder.name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\b`,
				"g",
			);
			for (const target of forwarder.exported ? sources.keys() : [file]) {
				scan(target, call, forwarder.index, forwarder.key);
			}
		}
	};

	for (const file of sources.keys()) scan(file, pattern, 0);
	return { uses, unresolved, forwarders };
}

/** The channels `GENERIC_LISTEN_CHANNELS` lets the renderer subscribe to. */
function genericListenChannels(constants: Map<string, string>): string[] {
	const source = blankComments(
		readFileSync(
			path.join(PRELOAD_DIR, "api", "modules", "generic-ipc-api.ts"),
			"utf-8",
		),
	);
	const start = source.indexOf("export const GENERIC_LISTEN_CHANNELS = [");
	const body = source.slice(start, source.indexOf("] as const", start));
	return [
		...body.matchAll(/IPC_CHANNELS\.([A-Z][A-Z0-9_]*)|"([^"]+)"/g),
	].flatMap((m) => {
		const channel = m[1] ? constants.get(m[1]) : m[2];
		return channel ? [channel] : [];
	});
}

describe("IPC channel parity (main → renderer)", () => {
	const constants = ipcChannelConstants();
	const sends = collectThroughForwarders(
		sourceFiles(MAIN_DIR),
		MAIN_SEND,
		constants,
	);
	const listens = collectThroughForwarders(
		sourceFiles(PRELOAD_DIR),
		PRELOAD_LISTEN,
		constants,
	);
	const heard = new Set([
		...listens.uses.map((u) => u.channel),
		...genericListenChannels(constants),
	]);
	const sent = new Set(sends.uses.map((u) => u.channel));
	const byChannel = (list: ChannelUse[]) => {
		const out = new Map<string, ChannelUse[]>();
		for (const use of list) out.set(use.channel, [...(out.get(use.channel) ?? []), use]);
		return out;
	};

	it("finds the channels on both sides", () => {
		expect(sent.size).toBeGreaterThan(200);
		expect(heard.size).toBeGreaterThan(200);
		expect(sends.forwarders.length).toBeGreaterThan(20);
	});

	it("resolves the channel of every send and every listener", () => {
		const report = (u: Unresolved) => `${where(u)}  ${u.argument}`;
		expect(sends.unresolved.map(report), "main sends").toEqual([]);
		expect(listens.unresolved.map(report), "preload listeners").toEqual([]);
	});

	it("has a preload listener for every channel the main process sends on", () => {
		const missing = [...byChannel(sends.uses)]
			.filter(([channel]) => !heard.has(channel))
			.filter(([channel]) => !(channel in UNHEARD_ALLOWLIST))
			.map(([channel, uses]) => `${channel}  (${uses.map(where).join(", ")})`)
			.sort();
		expect(missing, "sent by src/main, heard by nothing in src/preload").toEqual(
			[],
		);
	});

	it("keeps the unheard allowlist down to channels that still need it", () => {
		const stale = Object.keys(UNHEARD_ALLOWLIST)
			.filter((channel) => heard.has(channel) || !sent.has(channel))
			.sort();
		expect(stale, "heard or no longer sent — remove from UNHEARD_ALLOWLIST").toEqual(
			[],
		);
	});

	it("has a main-process sender for every channel the preload listens to", () => {
		const missing = [...byChannel(listens.uses)]
			.filter(([channel]) => !sent.has(channel))
			.map(([channel, uses]) => `${channel}  (${uses.map(where).join(", ")})`)
			.sort();
		expect(missing, "heard by src/preload, sent by nothing in src/main").toEqual(
			[],
		);
	});
});

/**
 * A channel is written once, in `IPC_CHANNELS`, and named from there on both
 * sides. A string repeated in main and preload drifts without anyone noticing:
 * a typo on either side is a call that never arrives.
 */
describe("IPC channels are named through IPC_CHANNELS", () => {
	const constants = ipcChannelConstants();
	const uses = [
		...collect(sourceFiles(PRELOAD_DIR), PRELOAD_CALL, constants).uses,
		...collect(sourceFiles(MAIN_DIR), MAIN_REGISTRATION, constants).uses,
		...collectThroughForwarders(sourceFiles(MAIN_DIR), MAIN_SEND, constants)
			.uses,
		...collectThroughForwarders(
			sourceFiles(PRELOAD_DIR),
			PRELOAD_LISTEN,
			constants,
		).uses,
	];

	it("keeps no constant that no IPC call uses", () => {
		const used = new Set([
			...uses.map((use) => use.channel),
			...collect(sourceFiles(RENDERER_DIR, true), RENDERER_CALL, constants)
				.uses.map((use) => use.channel),
			...genericListenChannels(constants),
		]);
		const orphans = [...constants]
			.filter(([, channel]) => !used.has(channel))
			.map(([key, channel]) => `${key}  ${channel}`)
			.sort();
		expect(orphans, "used by no handler, call, send or listener").toEqual([]);
	});

	it("names every channel of main and preload by its constant", () => {
		const literal = uses
			.filter((use) => !use.named)
			.map((use) => `${where(use)}  ${use.channel}`)
			.sort();
		expect(literal, "write it in IPC_CHANNELS and use the constant").toEqual(
			[],
		);
	});
});
