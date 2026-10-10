/**
 * A handler module can be complete and still be dead: `swarm-handlers.ts`,
 * `continuous-ai-handlers.ts` and `auto-refactor-handlers.ts` each exported a
 * fully written `register*Handlers`, and `setupIpcHandlers` never called any of
 * them. Three of 154 — invisible by reading either file on its own.
 *
 * Nothing failed loudly: `ipcRenderer.invoke` on an unregistered channel
 * rejects with "No handler registered for …", which the callers swallowed as a
 * best-effort failure. The features simply never worked.
 *
 * The same holds for the modules that name their entry point `setup*Handlers`
 * (or `setup*Handler`): `renderer-log-handler.ts` and
 * `context-aware-snippets-handlers.ts` were both never called, and a check that
 * only knew the `register*` spelling could not see them. The other `setup*`
 * exports — `setup*EventForwarding`, `setupVoiceControlEvents` — register no
 * `ipcMain` handler: they forward service events to the window, so a missing
 * call there loses events, not channels, and is not this test's question.
 *
 * This test reads the source rather than the runtime: registering for real
 * would need an Electron main process, and the defect is a missing line in a
 * file, which the file itself can answer for.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HANDLERS_DIR = path.resolve(import.meta.dirname, "..");
const INDEX = path.join(HANDLERS_DIR, "index.ts");

/**
 * Registrars defined but not called yet, each with the change that will call
 * it. An entry that is reachable again is reported as stale: the list only
 * shrinks.
 */
const UNREACHABLE_ALLOWLIST: Record<string, string> = {};

/** A registrar's name: `registerFooHandlers`, `setupFooHandlers`, `setupFooHandler`. */
const REGISTRAR = String.raw`(?:register\w*Handlers|setup\w*Handlers?)`;

/** `export function registerFooHandlers(` → `registerFooHandlers` */
function exportedRegistrars(source: string): string[] {
	return [
		...source.matchAll(new RegExp(String.raw`export function (${REGISTRAR})\s*\(`, "g")),
	].map((m) => m[1]);
}

/** Names called as functions somewhere in `source`, ignoring their own definition. */
function registrarCalls(source: string): Set<string> {
	const defined = new Set(exportedRegistrars(source));
	const called = new Set<string>();
	for (const m of source.matchAll(new RegExp(String.raw`\b(${REGISTRAR})\s*\(`, "g"))) {
		const name = m[1];
		// `export function foo(` matches the call pattern too — only count a
		// name as called when it appears somewhere other than its own header.
		const occurrences = [...source.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))]
			.length;
		if (!defined.has(name) || occurrences > 1) called.add(name);
	}
	return called;
}

/** Every handler module directly under `ipc-handlers/`, recursively. */
function handlerFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			out.push(...handlerFiles(full));
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("IPC handler registration", () => {
	const index = readFileSync(INDEX, "utf-8");

	// name → every module source that defines it. A list, not a single entry:
	// `registerGithubHandlers` is defined twice (`github-handlers.ts` and
	// `github/index.ts`), and keeping only one of them would follow the wrong
	// body and report its callees as unreachable.
	const definedIn = new Map<string, string[]>();
	for (const file of handlerFiles(HANDLERS_DIR)) {
		if (file === INDEX) continue;
		const source = readFileSync(file, "utf-8");
		for (const name of exportedRegistrars(source)) {
			definedIn.set(name, [...(definedIn.get(name) ?? []), source]);
		}
	}

	// `setupIpcHandlers` is the entry point; anything not reachable from its
	// body — directly, or through a domain aggregator such as
	// `registerGithubHandlers` — is never registered.
	const setupBody = index.slice(
		index.indexOf("export function setupIpcHandlers"),
	);

	const reachable = new Set<string>();
	const queue = [...registrarCalls(setupBody)];
	while (queue.length > 0) {
		const name = queue.pop() as string;
		if (reachable.has(name)) continue;
		reachable.add(name);
		for (const source of definedIn.get(name) ?? []) {
			queue.push(...registrarCalls(source));
		}
	}

	it("finds the handler modules", () => {
		// A refactor that moves or renames them should fail here loudly rather
		// than turn this whole test into a vacuous pass.
		expect(definedIn.size).toBeGreaterThan(100);
	});

	it("reaches every exported register*Handlers and setup*Handler(s) from setupIpcHandlers", () => {
		const unreachable = [...definedIn.keys()]
			.filter((name) => !reachable.has(name))
			.filter((name) => !(name in UNREACHABLE_ALLOWLIST))
			.sort();

		expect(unreachable).toEqual([]);
	});

	it("keeps the allowlist down to registrars that still need it", () => {
		const stale = Object.keys(UNREACHABLE_ALLOWLIST)
			.filter((name) => !definedIn.has(name) || reachable.has(name))
			.sort();

		expect(stale, "reachable now — remove from UNREACHABLE_ALLOWLIST").toEqual([]);
	});
});
