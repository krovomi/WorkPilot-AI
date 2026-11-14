/**
 * What a view shows when its Python runner fails.
 *
 * The runners print `<PREFIX>_ERROR:` followed by the message as a JSON
 * string (`_emit(prefix, str(exc))`, see `tests/test_runner_error_lines.py`).
 * Each handler here used to pass that text on as it arrived, so the view read
 * `"Project path does not exist: …"` with its quotes and its `\n` escapes. The
 * runner is a stand-in that prints exactly that line and exits with 1.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	sent: [] as Array<[string, unknown]>,
	stdout: "",
}));

vi.mock("electron", () => ({
	app: { isPackaged: false, getAppPath: () => "/app/frontend", getPath: () => "/tmp" },
	ipcMain: {
		handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
			mocks.handlers.set(channel, handler);
		},
		on: vi.fn(),
	},
	BrowserWindow: {
		getAllWindows: () => [
			{
				webContents: {
					send: (channel: string, payload: unknown) => mocks.sent.push([channel, payload]),
				},
			},
		],
	},
	dialog: {},
	shell: {},
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: () => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				kill: vi.fn(),
			});
			setTimeout(() => {
				child.stdout.emit("data", Buffer.from(mocks.stdout));
				child.emit("close", 1);
			}, 0);
			return child;
		},
	};
});

vi.mock("../../utils/ensure-python", () => ({ requirePythonPath: async () => "python" }));
vi.mock("../../utils/python-runner-env", () => ({ pythonRunnerEnv: async () => ({}) }));
vi.mock("../../security/renderer-path", async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveKnownProject: (raw: unknown) => (typeof raw === "string" ? raw : null),
}));
vi.mock("../server-analyses", () => ({
	serverProjectAtPath: () => null,
	relayServerAnalysis: vi.fn(),
	cancelServerAnalysis: vi.fn(),
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { runCompliance } from "../../compliance/runner";
import { runTranslator } from "../../i18n-agent/translate-run";
import { runNotebookRunner } from "../../notebook-agent/notebook-runs";
import { registerApiWatcherHandlers } from "../api-watcher-handlers";
import { registerConsensusArbiterHandlers } from "../consensus-arbiter-handlers";
import { registerDocDriftHandlers } from "../doc-drift-handlers";
import { registerI18nAgentHandlers } from "../i18n-agent-handlers";
import { registerInjectionGuardHandlers } from "../injection-guard-handlers";
import { registerNotebookAgentHandlers } from "../notebook-agent-handlers";
import { registerOnboardingAgentHandlers } from "../onboarding-agent-handlers";
import { registerRegressionGuardianHandlers } from "../regression-guardian-handlers";

const MESSAGE = 'Project path does not exist: /p/"shop"\nsee the logs';

let project: string;

beforeEach(() => {
	mocks.handlers.clear();
	mocks.sent.length = 0;
	project = mkdtempSync(path.join(tmpdir(), "runner-error-"));
});

afterEach(() => {
	vi.restoreAllMocks();
});

function runnerSays(prefix: string): void {
	mocks.stdout = `${prefix}:${JSON.stringify(MESSAGE)}\n`;
}

describe.each([
	["DOC_DRIFT_ERROR", registerDocDriftHandlers, IPC_CHANNELS.DOC_DRIFT_RUN, IPC_CHANNELS.DOC_DRIFT_ERROR],
	["NOTEBOOK_ERROR", registerNotebookAgentHandlers, IPC_CHANNELS.NOTEBOOK_AGENT_RUN, IPC_CHANNELS.NOTEBOOK_ERROR],
	["I18N_ERROR", registerI18nAgentHandlers, IPC_CHANNELS.I18N_AGENT_RUN, IPC_CHANNELS.I18N_AGENT_ERROR],
	["API_WATCHER_ERROR", registerApiWatcherHandlers, IPC_CHANNELS.API_WATCHER_RUN, IPC_CHANNELS.API_WATCHER_ERROR],
	[
		"CONSENSUS_ARBITER_ERROR",
		registerConsensusArbiterHandlers,
		IPC_CHANNELS.CONSENSUS_ARBITER_RUN,
		IPC_CHANNELS.CONSENSUS_ARBITER_ERROR,
	],
	[
		"INJECTION_GUARD_ERROR",
		registerInjectionGuardHandlers,
		IPC_CHANNELS.INJECTION_GUARD_RUN,
		IPC_CHANNELS.INJECTION_GUARD_ERROR,
	],
	["ONBOARDING_ERROR", registerOnboardingAgentHandlers, IPC_CHANNELS.ONBOARDING_AGENT_RUN, IPC_CHANNELS.ONBOARDING_ERROR],
	[
		"REGRESSION_GUARDIAN_ERROR",
		registerRegressionGuardianHandlers,
		IPC_CHANNELS.REGRESSION_GUARDIAN_RUN,
		IPC_CHANNELS.REGRESSION_GUARDIAN_ERROR,
	],
])("a run whose runner prints %s", (prefix, register, runChannel, errorChannel) => {
	it("shows the message, without the JSON quotes", async () => {
		register();
		runnerSays(prefix);

		const run = mocks.handlers.get(runChannel);
		expect(run).toBeDefined();
		await expect(run?.({}, { projectPath: project })).rejects.toThrow(MESSAGE);
		expect(mocks.sent).toContainEqual([errorChannel, MESSAGE]);
	});
});

describe("a one-shot runner that fails", () => {
	it("onboarding status says the runner's message", async () => {
		registerOnboardingAgentHandlers();
		runnerSays("ONBOARDING_ERROR");

		const status = mocks.handlers.get(IPC_CHANNELS.ONBOARDING_AGENT_STATUS);
		await expect(status?.({}, { projectPath: project })).rejects.toThrow(MESSAGE);
	});

	it("a notebook run says the runner's message", async () => {
		runnerSays("NOTEBOOK_ERROR");

		await expect(runNotebookRunner(["--execute"], "NOTEBOOK_EXECUTE:", 1000)).rejects.toThrow(MESSAGE);
	});

	it("a translation says the runner's message", async () => {
		runnerSays("I18N_ERROR");

		await expect(runTranslator(project, { referenceLocale: "en", locales: ["fr"] } as never)).rejects.toThrow(
			MESSAGE,
		);
	});

	it("a compliance report says the runner's message", async () => {
		runnerSays("COMPLIANCE_ERROR");

		const { result } = await runCompliance(project, ["--framework", "soc2"]);
		await expect(result).rejects.toThrow(MESSAGE);
	});

	it("a runner that printed plain text is shown as it is", async () => {
		mocks.stdout = "COMPLIANCE_ERROR:disk full\n";

		const { result } = await runCompliance(project, []);
		await expect(result).rejects.toThrow(/^disk full$/);
	});
});
