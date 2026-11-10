/** The release train (#362): the train file, its runs and its metrics. */

export interface TrainStepSpec {
	command: string[];
	url: string;
	timeout: number;
	expectStatus: number;
	retries: number;
}

export interface TrainServiceView {
	name: string;
	path: string;
	dependsOn: string[];
	criticality: "high" | "normal" | "low";
	external: boolean;
	steps: Partial<Record<"deploy" | "rollback" | "health" | "smoke", TrainStepSpec>>;
	passEnv: string[];
}

export type TrainProblem =
	| { code: "cycle"; services: string[]; cut: string[] }
	| { code: "unknown_dependency"; service: string; dependency: string }
	| { code: "no_deploy"; service: string };

export interface CalendarSlot {
	service: string;
	environment: string;
	at: string;
	end: string;
	minutes: number;
	conflict: boolean;
}

export type RunStatus =
	| "running"
	| "waiting"
	| "blocked"
	| "done"
	| "rolled_back"
	| "rollback_failed"
	| "aborted";

export type ItemStatus =
	| "pending"
	| "waiting_confirmation"
	| "deploying"
	| "done"
	| "failed"
	| "rolled_back"
	| "rollback_failed"
	| "skipped";

export interface StepOutcome {
	status: "passed" | "failed" | "timeout" | "error";
	detail: string;
	exitCode: number | null;
	httpStatus: number | null;
	attempts: number;
	durationS: number;
	output: string;
}

export interface TrainItem {
	service: string;
	wave: number;
	version: string;
	previousVersion: string;
	external: boolean;
	confirm: boolean;
	confirmed: boolean;
	status: ItemStatus;
	phase: string;
	steps: Partial<Record<"deploy" | "health" | "smoke", StepOutcome>>;
	rollback: StepOutcome | null;
	detail: string;
}

export interface TrainFlagState {
	key: string;
	provider: string;
	services: string[];
	state: "off" | "waiting" | "confirmed" | "on" | "failed";
}

export interface JournalEntry {
	at: string;
	kind: "info" | "ask" | "error";
	service: string;
	text: string;
}

export interface TrainRun {
	id: string;
	environment: string;
	production: boolean;
	express: boolean;
	status: RunStatus;
	createdAt: string;
	updatedAt?: string;
	endedAt?: string;
	gateFailures: number;
	blocked: { kind: "service" | "flag"; name: string; step: string; detail: string } | null;
	warnings: { code: "calendar"; service: string; at: string }[];
	items: TrainItem[];
	flags: TrainFlagState[];
	journal?: JournalEntry[];
}

export interface TrainView {
	path: string;
	sha256: string;
	environments: { name: string; production: boolean }[];
	services: TrainServiceView[];
	order: { waves: string[][]; cycle: string[]; suggestion: string[] | null; unknown: Record<string, string[]> };
	flags: { key: string; services: string[]; provider: string; environment: string }[];
	problems: TrainProblem[];
	variables: string[];
	calendar: { slots: CalendarSlot[]; conflicts: number[][] };
	runs: TrainRun[];
}

/** What main answers for a project: its train file, and whether this version of it is approved. */
export interface TrainState {
	present: boolean;
	approved: boolean;
	error?: string;
	view?: TrainView;
}

export type TrainAction = "continue" | "confirm" | "retry" | "rollback" | "abort";

export interface TrainMonth {
	month: string;
	trains: number;
	multiService: number;
	meanMinutes: number | null;
	blockedByGates: number;
	rollbacks: number;
	rollbacksOk: number;
}

export interface TrainNotes {
	markdown: string;
	by: "rules" | "model";
}
