import { create } from "zustand";
import type { FlakyTestsEvent } from "../../preload/api/modules/flaky-tests-api";
import type {
	DetectedTestCommand,
	FlakyCommandId,
	FlakyReport,
	FlakyRunProgress,
} from "../../shared/types/flaky-tests";

export type FlakyTestsPhase = "idle" | "scanning" | "complete" | "error";

export const DEFAULT_FLAKY_RUNS = 5;

/** What is running now: reading the reports, or running the suite. */
export interface FlakyActivity {
	mode: "scan" | "run";
	/** The event code of the last step (`running`, `run_started`, `parsing`…). */
	code: string;
	command: string;
	run: number;
	runs: number;
	reports: number;
	finished: FlakyRunProgress[];
}

const IDLE_ACTIVITY: FlakyActivity = {
	mode: "scan",
	code: "",
	command: "",
	run: 0,
	runs: 0,
	reports: 0,
	finished: [],
};

interface FlakyTestsState {
	phase: FlakyTestsPhase;
	/** English status of older runners; the view words `activity` itself. */
	status: string;
	activity: FlakyActivity;
	report: FlakyReport | null;
	error: string | null;

	/** The project the detected commands belong to. */
	detectedFor: string | null;
	detecting: boolean;
	commands: DetectedTestCommand[];
	/** A server project: the command is detected on the server. */
	remote: boolean;
	commandId: FlakyCommandId | "auto";
	runs: number;

	detectCommands: (projectPath: string) => Promise<void>;
	setCommandId: (commandId: FlakyCommandId | "auto") => void;
	setRuns: (runs: number) => void;
	startScan: (projectPath: string) => Promise<void>;
	startRuns: (projectPath: string) => Promise<void>;
	cancelScan: () => Promise<void>;
	applyEvent: (event: FlakyTestsEvent) => void;
	setStatus: (status: string) => void;
	setReport: (report: FlakyReport) => void;
	setError: (error: string) => void;
	reset: () => void;
}

export const useFlakyTestsStore = create<FlakyTestsState>((set, get) => {
	const run = async (
		projectPath: string,
		mode: "scan" | "run",
	): Promise<void> => {
		if (!projectPath) {
			set({ phase: "error", error: "No project selected" });
			return;
		}
		const { commandId, runs } = get();
		set({
			phase: "scanning",
			status: "",
			activity: { ...IDLE_ACTIVITY, mode, runs: mode === "run" ? runs : 0 },
			report: null,
			error: null,
		});
		try {
			const report = await globalThis.electronAPI.runFlakyTestsScan(
				mode === "run"
					? { projectPath, mode, runs, commandId }
					: { projectPath, mode },
			);
			// A cancel came first: what the runner said after it is moot.
			if (get().phase !== "scanning") return;
			set({ phase: "complete", report, status: "" });
		} catch (err) {
			if (get().phase !== "scanning") return;
			set({
				phase: "error",
				error: err instanceof Error ? err.message : String(err),
			});
		}
	};

	return {
		phase: "idle",
		status: "",
		activity: IDLE_ACTIVITY,
		report: null,
		error: null,
		detectedFor: null,
		detecting: false,
		commands: [],
		remote: false,
		commandId: "auto",
		runs: DEFAULT_FLAKY_RUNS,

		detectCommands: async (projectPath) => {
			if (!projectPath) return;
			set({ detecting: true });
			try {
				const result =
					await globalThis.electronAPI.detectFlakyTestCommands({ projectPath });
				const keep = result.commands.some((c) => c.id === get().commandId);
				set({
					detectedFor: projectPath,
					commands: result.commands,
					remote: result.remote,
					commandId: keep ? get().commandId : (result.commands[0]?.id ?? "auto"),
				});
			} catch {
				set({ detectedFor: projectPath, commands: [], remote: false });
			} finally {
				set({ detecting: false });
			}
		},

		setCommandId: (commandId) => set({ commandId }),
		setRuns: (runs) => set({ runs }),

		startScan: (projectPath) => run(projectPath, "scan"),
		startRuns: (projectPath) => run(projectPath, "run"),

		cancelScan: async () => {
			set({ phase: "idle", status: "", activity: IDLE_ACTIVITY });
			await globalThis.electronAPI.cancelFlakyTestsScan();
		},

		applyEvent: (event) => {
			const data = event?.data;
			if (!data || get().phase !== "scanning") return;
			const activity = { ...get().activity };
			if (data.code) activity.code = data.code;
			if (data.command) activity.command = data.command;
			if (typeof data.runs === "number") activity.runs = data.runs;
			if (typeof data.run === "number") activity.run = data.run;
			if (typeof data.reports === "number") activity.reports = data.reports;
			if (data.code === "run_finished" && typeof data.run === "number") {
				activity.finished = [
					...activity.finished.filter((r) => r.run !== data.run),
					{
						run: data.run,
						passed: data.passed ?? 0,
						failed: data.failed ?? 0,
						exitCode: data.exitCode ?? null,
						timedOut: data.timedOut ?? false,
						durationS: data.durationS ?? 0,
					},
				];
			}
			set({ activity, status: data.status ?? get().status });
		},

		setStatus: (status) => set({ status }),
		setReport: (report) => set({ report, phase: "complete" }),
		setError: (error) => {
			// An error that follows a cancel is the cancel itself.
			if (get().phase !== "scanning") return;
			set({ error, phase: "error" });
		},
		reset: () =>
			set({
				phase: "idle",
				status: "",
				activity: IDLE_ACTIVITY,
				report: null,
				error: null,
			}),
	};
});

export function setupFlakyTestsListeners(): () => void {
	const store = () => useFlakyTestsStore.getState();

	const unsubEvent = globalThis.electronAPI.onFlakyTestsEvent(
		(event: FlakyTestsEvent) => {
			store().applyEvent(event);
		},
	);

	const unsubResult = globalThis.electronAPI.onFlakyTestsResult(
		(report: FlakyReport) => {
			store().setReport(report);
		},
	);

	const unsubError = globalThis.electronAPI.onFlakyTestsError(
		(error: string) => {
			store().setError(error);
		},
	);

	return () => {
		unsubEvent();
		unsubResult();
		unsubError();
	};
}
