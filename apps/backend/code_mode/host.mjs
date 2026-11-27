// The host of one `run_script` call: runs the model's script in a V8 context
// whose only way out is a request to the Python executor.
//
// Launched by `code_mode/runner.py` as
//   node --permission --allow-fs-read=<this file> --disallow-code-generation-from-strings host.mjs
// so the process itself can read no other file, write none, start no process,
// no worker and no addon. The script runs in a fresh `vm` context that holds
// no `require`, no `process`, no `fetch` and no timer: the functions below are
// all it has, and each one is a line on stdout that the executor answers on
// stdin after its own checks (rights of the agent type, path guard, command
// allowlist, guardrails, OS sandbox). `eval` and `Function` are refused in the
// script's context and in this one, so a constructor reached from a host
// object cannot compile its way back to `process`.
//
// Protocol, one JSON object per line:
//   stdin  first  {"code": "...", "maxCalls": 50}
//   stdin  then   {"id": 1, "ok": true, "value": ...} | {"id": 1, "ok": false, "error": "..."}
//   stdout        {"type": "call", "id": 1, "tool": "read_file", "args": {...}}
//                 {"type": "log", "text": "..."}
//                 {"type": "done", "value": "..."} | {"type": "error", "error": "..."}

import readline from "node:readline";
import vm from "node:vm";

const send = (message) => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};

const pending = new Map();
let nextId = 1;
let maxCalls = 50;
let started = false;

function rpc(tool, argsJson) {
	if (nextId > maxCalls) {
		return Promise.reject(
			new Error(`this script made more than ${maxCalls} tool calls, the limit of one script`),
		);
	}
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ type: "call", id, tool: String(tool), args: JSON.parse(String(argsJson)) });
	});
}

function log(text) {
	send({ type: "log", text: String(text) });
}

// Compiled inside the script's context, so every value the script handles,
// arguments and results, belongs to that context and not to this one.
const PRELUDE = `
(() => {
	const rpc = globalThis.__rpc;
	const log = globalThis.__log;
	delete globalThis.__rpc;
	delete globalThis.__log;
	const call = async (tool, args) => {
		const raw = await rpc(String(tool), JSON.stringify(args ?? {}));
		return JSON.parse(raw);
	};
	const text = (value) => (typeof value === "string" ? value : JSON.stringify(value));
	const api = {
		read: (path, options = {}) => call("read_file", { path, ...options }),
		write: (path, content) => call("write_file", { path, content: String(content) }),
		edit: (path, oldText, newText, options = {}) =>
			call("edit_file", { path, old: String(oldText), new: String(newText), all: !!options.all }),
		search: (pattern, options = {}) => call("search_files", { pattern, ...options }),
		find: (pattern, options = {}) => call("find_files", { pattern, ...options }),
		list: (directory = ".") => call("list_files", { directory }),
		run: (command, options = {}) => call("run_command", { command, ...options }),
		tool: (name, args = {}) => call(name, args),
	};
	const console = {};
	for (const level of ["log", "info", "warn", "error", "debug"]) {
		console[level] = (...values) => log(values.map(text).join(" "));
	}
	Object.freeze(api);
	Object.freeze(console);
	for (const [name, value] of Object.entries(api)) globalThis[name] = value;
	globalThis.console = console;
})();
`;

async function runScript(code) {
	const context = vm.createContext(
		{ __rpc: rpc, __log: log },
		{ codeGeneration: { strings: false, wasm: false }, name: "run_script" },
	);
	new vm.Script(PRELUDE, { filename: "prelude.js" }).runInContext(context);
	const wrapped = `(async () => {\n${code}\n})()`;
	const script = new vm.Script(wrapped, { filename: "script.js", lineOffset: -1 });
	const value = await script.runInContext(context, { timeout: 30_000 });
	const render = new vm.Script(
		"(v) => v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2)",
	).runInContext(context);
	return String(render(value) ?? "");
}

// The error and where it happened in the script; the host's own frames are noise.
function describe(error) {
	const message = String(error?.message ?? error);
	const frames = String(error?.stack ?? "")
		.split("\n")
		.filter((line) => line.includes("script.js"))
		.map((line) => line.trim());
	return [message, ...frames].join("\n");
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (!started) {
		started = true;
		if (Number.isInteger(message.maxCalls) && message.maxCalls > 0) {
			maxCalls = message.maxCalls;
		}
		runScript(String(message.code ?? ""))
			.then((value) => send({ type: "done", value }))
			.catch((error) => send({ type: "error", error: describe(error) }))
			.finally(() => lines.close());
		return;
	}
	const waiter = pending.get(message.id);
	if (!waiter) return;
	pending.delete(message.id);
	if (message.ok) waiter.resolve(JSON.stringify(message.value ?? null));
	else waiter.reject(new Error(String(message.error ?? "the call failed")));
});
lines.on("close", () => {
	// A script still waiting on a call when stdin closes has been stopped.
	for (const waiter of pending.values()) waiter.reject(new Error("stopped"));
});
