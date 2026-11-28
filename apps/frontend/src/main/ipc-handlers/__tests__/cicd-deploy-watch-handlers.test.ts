/**
 * @vitest-environment node
 *
 * The watch after a deployment on the CI/CD handlers (#366): a triggered run
 * is watched when the settings name something to watch, the runs list carries
 * each watch, and a rollback names a known project and a run id only.
 */

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const state = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
	projects: [] as Array<{ id: string; name?: string; path: string; autoBuildPath: string }>,
	spawned: [] as string[][],
	envs: [] as Array<Record<string, string>>,
	announced: [] as Array<{ projectId: string; text: { title: string; body: string } }>,
	answers: [] as Array<{ code: number; stdout?: string; stderr?: string; hold?: Promise<void> }>,
	envThrows: false,
	envReads: 0,
}));

vi.mock("electron", async () => {
	const { sharedFakeSafeStorage } = await import("../../../__tests__/helpers/fake-safe-storage");
	return {
		app: { getPath: () => tmpdir(), getAppPath: () => tmpdir(), isPackaged: false },
		safeStorage: sharedFakeSafeStorage().safeStorage,
		ipcMain: {
			handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler),
		},
	};
});

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: (_cmd: string, args: string[], options: { env: Record<string, string> }) => {
		state.spawned.push(args);
		state.envs.push(options.env);
		const answer = state.answers.shift() ?? { code: 0, stdout: "{}" };
		const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		void (answer.hold ?? Promise.resolve()).then(() =>
			setTimeout(() => {
				if (answer.stdout) proc.stdout.emit("data", Buffer.from(answer.stdout));
				if (answer.stderr) proc.stderr.emit("data", Buffer.from(answer.stderr));
				proc.emit("close", answer.code);
			}, 0),
		);
		return proc;
	},
}));

vi.mock("../../project-env-file", async (importOriginal) => {
	const real = await importOriginal<typeof import("../../project-env-file")>();
	return {
		...real,
		readProjectEnv: (...args: Parameters<typeof real.readProjectEnv>) => {
			state.envReads += 1;
			// The runner's environment is read first; the watch reads the settings again.
			if (state.envThrows && state.envReads > 1) throw new Error("cannot decrypt");
			return real.readProjectEnv(...args);
		},
	};
});

vi.mock("../../project-store", () => ({
	projectStore: { getProjects: () => state.projects },
}));
vi.mock("../../python-env-manager", () => ({ getConfiguredPythonPath: () => "python3" }));
vi.mock("../../utils/python-runner-env", () => ({
	pythonRunnerEnv: async (_backend: string, options: { extra?: Record<string, string> }) => ({
		PROVIDER_ENV: "from-runner-env",
		...options.extra,
	}),
}));
const language = vi.hoisted(() => ({ current: "en" }));
vi.mock("../../app-language", () => ({ getAppLanguage: () => language.current }));
vi.mock("../../notification-service", () => ({
	notificationService: {
		announce: (projectId: string, text: { title: string; body: string }) =>
			state.announced.push({ projectId, text }),
	},
}));

import { IPC_CHANNELS } from "../../../shared/constants/ipc";
import { registerCICDTriggersHandlers } from "../cicd-triggers-handlers";

const RUNNER = "deploy_watch_runner.py";

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
	const handler = state.handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return Promise.resolve(handler({}, ...args));
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("CI/CD deployment watch", () => {
	let projectDir: string;

	function configure(lines: string[]) {
		mkdirSync(path.join(projectDir, ".workpilot"), { recursive: true });
		writeFileSync(path.join(projectDir, ".workpilot", ".env"), `${lines.join("\n")}\n`, "utf-8");
	}

	function writeWatch(runId: string, content: object) {
		const dir = path.join(projectDir, ".workpilot", "deploy_watches");
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(content), "utf-8");
	}

	function writeRuns(runs: object[]) {
		mkdirSync(path.join(projectDir, ".workpilot"), { recursive: true });
		writeFileSync(path.join(projectDir, ".workpilot", "cicd_runs.json"), JSON.stringify(runs), "utf-8");
	}

	beforeEach(() => {
		projectDir = mkdtempSync(path.join(tmpdir(), "cicd-watch-"));
		state.projects = [{ id: "p1", name: "Shop", path: projectDir, autoBuildPath: ".workpilot" }];
		state.spawned = [];
		state.envs = [];
		state.announced = [];
		state.answers = [];
		state.envThrows = false;
		state.envReads = 0;
		state.handlers.clear();
		registerCICDTriggersHandlers();
	});

	afterEach(() => {
		rmSync(projectDir, { recursive: true, force: true });
	});

	it("watches a triggered run when a health check is configured", async () => {
		configure(["CICD_PROVIDER=github", "CICD_MONITOR_HEALTH_URL=https://app.example/health"]);
		let release: () => void = () => undefined;
		const hold = new Promise<void>((r) => {
			release = r;
		});
		state.answers = [{ code: 0, stdout: '{"status":"triggered"}' }, { code: 0, stdout: "{}", hold }];
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, { provider: "github" });
		await tick();
		expect(state.spawned).toHaveLength(2);
		const watchArgs = state.spawned[1];
		expect(watchArgs.some((a) => a.endsWith(RUNNER))).toBe(true);
		const runId = watchArgs[watchArgs.indexOf("--run-id") + 1];
		expect(watchArgs.slice(-10)).toEqual([
			"--action",
			"watch",
			"--project",
			projectDir,
			"--run-id",
			runId,
			"--project-name",
			"Shop",
			"--language",
			"en",
		]);

		writeWatch(runId, { run_id: runId, phase: "watching", verdict: "ok" });
		const listed = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_LIST_RUNS, projectDir)) as {
			data: Array<{ id: string; watch?: { phase: string } }>;
		};
		expect(listed.data[0].watch?.phase).toBe("watching");

		// No rollback while the window is open.
		expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, projectDir, runId)).toEqual({
			success: false,
			error: "watch-running",
		});
		release();
		await tick();
		await tick();
		const after = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_LIST_RUNS, projectDir)) as {
			data: Array<{ watch?: { phase: string } }>;
		};
		expect(after.data[0].watch?.phase).toBe("interrupted");
	});

	it("runs the watch in the runner env and announces a bad verdict", async () => {
		configure(["CICD_PROVIDER=github", "CICD_MONITOR_HEALTH_URL=https://app.example/health"]);
		let runId = "";
		let release: () => void = () => undefined;
		const hold = new Promise<void>((r) => {
			release = r;
		});
		state.answers = [{ code: 0, stdout: "{}" }, { code: 0, stdout: "{}", hold }];
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, { provider: "github" });
		await tick();
		const watchArgs = state.spawned[1];
		runId = watchArgs[watchArgs.indexOf("--run-id") + 1];
		expect(state.envs[1]).toMatchObject({
			PROVIDER_ENV: "from-runner-env",
			CICD_MONITOR_HEALTH_URL: "https://app.example/health",
		});
		// The trigger itself keeps the environment without credentials.
		expect(state.envs[0].PROVIDER_ENV).toBeUndefined();
		writeWatch(runId, {
			run_id: runId,
			phase: "done",
			verdict: "critical",
			revert_pr: { status: "opened", url: "https://github.com/acme/shop/pull/7" },
		});
		release();
		await tick();
		await tick();
		expect(state.announced).toEqual([
			{
				projectId: "p1",
				text: {
					title: "Deployment critical: Shop",
					body: `Run ${runId}: two critical samples in a row after the deployment. Revert PR: https://github.com/acme/shop/pull/7`,
				},
			},
		]);
	});

	it("passes the app's language to the runner, English for any other", async () => {
		configure(["CICD_PROVIDER=github", "CICD_MONITOR_HEALTH_URL=https://app.example/health"]);
		for (const [app, sent] of [
			["fr", "fr"],
			["de", "en"],
		]) {
			language.current = app;
			state.spawned = [];
			state.answers = [{ code: 0, stdout: "{}" }, { code: 0, stdout: "{}" }];
			await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, { provider: "github" });
			await tick();
			await tick();
			const args = state.spawned[1];
			expect(args[args.indexOf("--language") + 1]).toBe(sent);
		}
		language.current = "en";
	});

	it("announces nothing for a healthy watch", async () => {
		configure(["CICD_PROVIDER=github", "CICD_MONITOR_HEALTH_URL=https://app.example/health"]);
		state.answers = [{ code: 0, stdout: "{}" }, { code: 0, stdout: "{}" }];
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, { provider: "github" });
		await tick();
		await tick();
		expect(state.spawned).toHaveLength(2);
		expect(state.announced).toEqual([]);
	});

	it("does not watch without anything to watch, or after a failed trigger", async () => {
		configure(["CICD_PROVIDER=github"]);
		state.answers = [{ code: 0, stdout: "{}" }];
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, { provider: "github" });
		configure(["CICD_PROVIDER=github", "CICD_MONITOR_PROMETHEUS_URL=http://localhost:9090"]);
		state.answers = [{ code: 1, stderr: "nope" }];
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, { provider: "github" });
		await tick();
		expect(state.spawned.every((args) => !args.some((a) => a.endsWith(RUNNER)))).toBe(true);
	});

	it("does not watch when the settings cannot be read", async () => {
		configure(["CICD_PROVIDER=github", "CICD_MONITOR_HEALTH_URL=https://app.example/health"]);
		state.answers = [{ code: 0, stdout: "{}" }];
		state.envThrows = true;
		await invoke(IPC_CHANNELS.CICD_TRIGGERS_TRIGGER, projectDir, { provider: "github" });
		await tick();
		expect(state.spawned).toHaveLength(1);
	});

	it("lists runs without a watch as they are", async () => {
		writeRuns([{ id: "1" }, { name: "no id" }]);
		const listed = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_LIST_RUNS, projectDir)) as {
			data: object[];
		};
		expect(listed.data).toEqual([{ id: "1" }, { name: "no id" }]);
	});

	it("shows and saves the watch settings, token masked", async () => {
		configure([
			"CICD_MONITOR_HEALTH_URL=https://app.example/health",
			"CICD_MONITOR_PROMETHEUS_TOKEN=prom-test-0000",
			"CICD_AUTO_ROLLBACK=true",
		]);
		const config = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_GET_CONFIG, projectDir)) as {
			data: Record<string, unknown>;
		};
		expect(config.data).toMatchObject({
			monitor_health_url: "https://app.example/health",
			monitor_prometheus_url: "",
			monitor_prometheus_token: "***",
			monitor_window_minutes: "",
			monitor_deploy_wait_minutes: "",
			auto_rollback: true,
		});
		const empty = mkdtempSync(path.join(tmpdir(), "cicd-watch-empty-"));
		state.projects.push({ id: "p2", path: empty, autoBuildPath: ".workpilot" });
		const blank = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_GET_CONFIG, empty)) as {
			data: Record<string, unknown>;
		};
		expect(blank.data).toMatchObject({ monitor_prometheus_token: "", auto_rollback: false });
		rmSync(empty, { recursive: true, force: true });
	});

	it("masks the keys of the other sources and the alert channels, and keeps them on a masked save", async () => {
		configure([
			"CICD_MONITOR_SOURCE=datadog",
			"CICD_MONITOR_DATADOG_SITE=datadoghq.eu",
			"CICD_MONITOR_DATADOG_API_KEY=dd-api-0000",
			"CICD_ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/test0000",
			"CICD_ALERT_EMAIL_TO=oncall@example.com",
			"CICD_ROLLBACK_FLAG_PROVIDER=unleash",
			"CICD_ROLLBACK_FLAG_KEY=new-checkout",
			"CICD_ROLLBACK_FLAG_TOKEN=unleash-0000",
		]);
		const config = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_GET_CONFIG, projectDir)) as {
			data: Record<string, unknown>;
		};
		expect(config.data).toMatchObject({
			monitor_source: "datadog",
			monitor_datadog_site: "datadoghq.eu",
			monitor_datadog_api_key: "***",
			monitor_datadog_app_key: "",
			alert_slack_webhook_url: "***",
			alert_smtp_password: "",
			alert_email_to: "oncall@example.com",
			rollback_flag_provider: "unleash",
			rollback_flag_key: "new-checkout",
			rollback_flag_token: "***",
			rollback_flag_user: "",
		});
		expect(JSON.stringify(config.data)).not.toContain("test0000");
		expect(JSON.stringify(config.data)).not.toContain("unleash-0000");
		const { toCicdEnvUpdate } = await import("../cicd-triggers-handlers");
		expect(
			toCicdEnvUpdate({
				alert_slack_webhook_url: "***",
				monitor_datadog_api_key: "***",
				alert_smtp_port: "465",
				rollback_flag_token: "***",
				rollback_flag_environment: "production",
			}),
		).toEqual({ ok: true, update: { CICD_ALERT_SMTP_PORT: "465", CICD_ROLLBACK_FLAG_ENVIRONMENT: "production" } });
	});

	describe("rollback", () => {
		it("refuses an unknown project and a bad run id", async () => {
			expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, "/elsewhere", "1")).toMatchObject({
				success: false,
			});
			for (const id of ["../x", 7, "1; rm -rf /"]) {
				expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, projectDir, id)).toEqual({
					success: false,
					error: "Invalid run id",
				});
			}
			expect(state.spawned).toEqual([]);
		});

		it("runs the rollback and returns the watch", async () => {
			writeWatch("42", { run_id: "42", phase: "done", verdict: "critical", rollback: "started" });
			state.answers = [{ code: 0, stdout: "{}" }];
			const result = (await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, projectDir, "42")) as {
				success: boolean;
				data: { rollback: string };
			};
			expect(result.success).toBe(true);
			expect(result.data.rollback).toBe("started");
			expect(state.spawned[0].slice(-6)).toEqual([
				"--action",
				"rollback",
				"--project",
				projectDir,
				"--run-id",
				"42",
			]);
		});

		it("says why the runner refused", async () => {
			state.answers = [{ code: 1, stderr: '{"error": "run not watched"}' }];
			expect(await invoke(IPC_CHANNELS.CICD_TRIGGERS_ROLLBACK, projectDir, "42")).toEqual({
				success: false,
				error: '{"error": "run not watched"}',
			});
		});
	});
});
