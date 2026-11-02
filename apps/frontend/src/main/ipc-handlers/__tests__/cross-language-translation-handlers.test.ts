/**
 * @vitest-environment node
 *
 * The "Traduction inter-langages" page. Its runner was looked for outside the
 * repository, the pasted code replaced the first argument instead of being
 * passed as `--file`, and the result was parsed from stdout mixed with the
 * streamed text. Pinned here: the runner path, the arguments, the marker
 * protocol, the history and the temporary file's removal.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const state = vi.hoisted(() => ({
	handlers: new Map<string, Handler>(),
	spawned: [] as Array<{ cmd: string; args: string[]; source?: string }>,
	stdout: [] as string[],
	exitCode: 0,
}));

vi.mock("electron", () => ({
	app: {
		isPackaged: false,
		getAppPath: () => path.join("/repo", "apps", "frontend"),
	},
	ipcMain: {
		handle: (channel: string, handler: Handler) =>
			state.handlers.set(channel, handler),
	},
}));

vi.mock("../../python-env-manager", () => ({
	getConfiguredPythonPath: () => "python3",
}));

vi.mock("../../python-detector", () => ({
	parsePythonCommand: (p: string) => [p, []],
}));

vi.mock("../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async () => ({}),
}));

vi.mock("node:child_process", async () => {
	const { readFileSync: read } = await import("node:fs");
	return {
		spawn: (cmd: string, args: string[]) => {
			const fileIdx = args.indexOf("--file");
			state.spawned.push({
				cmd,
				args,
				source: fileIdx >= 0 ? read(args[fileIdx + 1], "utf-8") : undefined,
			});
			const proc = new EventEmitter() as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
				kill: () => void;
			};
			proc.stdout = new EventEmitter();
			proc.stderr = new EventEmitter();
			proc.kill = () => undefined;
			setTimeout(() => {
				// Split mid-line on purpose: the handler must buffer lines.
				const all = state.stdout.join("");
				const cut = Math.floor(all.length / 2);
				proc.stdout.emit("data", Buffer.from(all.slice(0, cut)));
				proc.stdout.emit("data", Buffer.from(all.slice(cut)));
				proc.emit("close", state.exitCode);
			}, 0);
			return proc;
		},
	};
});

describe("cross-language translation handlers", () => {
	let projectDir: string;
	const sent: Array<[string, unknown]> = [];
	const event = {
		sender: {
			isDestroyed: () => false,
			send: (channel: string, payload: unknown) => sent.push([channel, payload]),
		},
	};

	beforeEach(async () => {
		state.handlers.clear();
		state.spawned = [];
		state.stdout = [];
		state.exitCode = 0;
		sent.length = 0;
		projectDir = mkdtempSync(path.join(tmpdir(), "cross-lang-"));
		const { registerCrossLanguageTranslationHandlers } = await import(
			"../cross-language-translation-handlers"
		);
		registerCrossLanguageTranslationHandlers();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	const translate = (params: Record<string, unknown>) =>
		state.handlers.get("crossLangTranslation:translate")?.(event, {
			projectDir,
			sourceLang: "python",
			targetLang: "typescript",
			code: "def add(a, b):\n    return a + b\n",
			...params,
		}) as Promise<{
			success: boolean;
			data?: { translated_code: string; test_code?: string | null };
			error?: string;
		}>;

	it("runs the runner of the repository's backend with the code as --file", async () => {
		state.stdout = [
			"__STATUS__:generating\n",
			`__DELTA__:${JSON.stringify("```ts\nexport ")}\n`,
			`__DELTA__:${JSON.stringify("const x = 1;\n```")}\n`,
			`__RESULT__:${JSON.stringify({ translated_code: "export const x = 1;", test_code: null })}\n`,
		];

		const result = await translate({ generateTests: true });

		expect(result).toEqual({
			success: true,
			data: { translated_code: "export const x = 1;", test_code: null },
		});
		const [run] = state.spawned;
		expect(run.cmd).toBe("python3");
		// resolve(): the handler resolves the app path, which adds the drive
		// letter on Windows.
		expect(run.args[0]).toBe(
			path.resolve(
				"/repo",
				"apps",
				"backend",
				"runners",
				"cross_language_translation_runner.py",
			),
		);
		expect(run.args.slice(1, 5)).toEqual([
			"--source-lang",
			"python",
			"--target-lang",
			"typescript",
		]);
		expect(run.args).toContain("--generate-tests");
		expect(run.source).toBe("def add(a, b):\n    return a + b\n");
		// Only the model's text goes to the page, in order.
		expect(sent.map(([, text]) => text).join("")).toBe(
			"```ts\nexport const x = 1;\n```",
		);
		// The snippet's temporary copy is gone.
		const file = run.args[run.args.indexOf("--file") + 1];
		expect(existsSync(file)).toBe(false);
		expect(file.startsWith(projectDir)).toBe(false);

		const history = JSON.parse(
			readFileSync(
				path.join(projectDir, ".workpilot", "translation_history.json"),
				"utf-8",
			),
		);
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			source_lang: "python",
			target_lang: "typescript",
			lines: 2,
			status: "complete",
		});
	});

	it("reports the runner's own error, not its raw stdout", async () => {
		state.exitCode = 1;
		state.stdout = [
			`__ERROR__:${JSON.stringify({ message: "Not signed in", code: "auth_required" })}\n`,
		];

		const result = await translate({});

		expect(result).toEqual({ success: false, error: "Not signed in" });
		const history = JSON.parse(
			readFileSync(
				path.join(projectDir, ".workpilot", "translation_history.json"),
				"utf-8",
			),
		);
		expect(history[0].status).toBe("failed");
	});

	it("refuses an unknown language or empty code without spawning", async () => {
		expect(await translate({ targetLang: "cobol" })).toMatchObject({
			success: false,
		});
		expect(await translate({ code: "  " })).toMatchObject({ success: false });
		expect(state.spawned).toHaveLength(0);
	});
});

describe("parseRunnerLine", () => {
	it("reads each marker and ignores the rest", async () => {
		const { parseRunnerLine } = await import(
			"../cross-language-translation-handlers"
		);
		expect(parseRunnerLine(`__DELTA__:${JSON.stringify("a\nb")}`)).toEqual({
			kind: "delta",
			text: "a\nb",
		});
		expect(parseRunnerLine("__STATUS__:parsing")).toEqual({
			kind: "status",
			status: "parsing",
		});
		expect(parseRunnerLine('__RESULT__:{"nope":1}')).toBeNull();
		expect(parseRunnerLine("__DELTA__:{broken")).toBeNull();
		expect(parseRunnerLine("INFO some log line")).toBeNull();
	});
});
