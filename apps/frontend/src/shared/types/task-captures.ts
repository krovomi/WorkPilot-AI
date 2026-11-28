/**
 * The captures a task prepared for its pull request, as the app shows them
 * (`main/task-captures/`, design: `docs/architecture/pr-captures.md`).
 *
 * The backend writes two files beside the spec: `captures/publication.json`
 * (which screens, before and after, what was checked on each copy) and
 * `captures/pr-sync.json` (what the last update of the pull request did).
 * The main process reads them, keeps the fields below and nothing else: a
 * kind of personal data is named, a value never is (there is none in them).
 */

/** The card's own choice; absent: the project's `CAPTURES_MODE`. */
export type TaskCapturesChoice = "always" | "never";

/** What a person can ask from the Captures tab (`runners/pr_captures_runner.py`). */
export type TaskCapturesAction = "approve" | "withdraw" | "sync";

export const TASK_CAPTURES_ACTIONS: readonly TaskCapturesAction[] = [
	"approve",
	"withdraw",
	"sync",
];

/** `CAPTURES_PUBLISH`: straight into the PR, after a person's "Publish", or never. */
export type TaskCapturesPublishMode = "auto" | "review" | "never";

/**
 * A copy's verdict (`pr_captures/privacy.py`): `pseudonymized` (fakes in
 * place of personal data) and `clean` are published; `unchecked`, `withheld`
 * and `failed` stay on the task.
 */
export type TaskCaptureStatus =
	| "pseudonymized"
	| "clean"
	| "unchecked"
	| "withheld"
	| "failed";

export interface TaskCaptureSide {
	/** A publishable copy exists under `captures/published/`. */
	available: boolean;
	status: TaskCaptureStatus;
	/** Kinds replaced or found (`email`, `phone`, `iban`…), never a value. */
	kinds: string[];
	/** The passes that ran (`page`, `ocr:tesseract`…). */
	passes: string[];
	/** How many values were replaced by fakes. */
	replaced: number;
	/** The copy, relative to the spec folder; empty when none. Read by `getTaskCaptureImage`. */
	file: string;
}

export interface TaskCaptureItem {
	key: string;
	label: string;
	/** `web`, `desktop`, `android`, `ios`. */
	platform: string;
	/** `mobile` for the phone view of a web page; empty otherwise. */
	variant: string;
	route: string;
	locale: string;
	before?: TaskCaptureSide;
	after: TaskCaptureSide;
	publishable: boolean;
}

export type TaskCapturesSyncStatus =
	| "published"
	| "waiting-review"
	| "off"
	| "nothing"
	| "no-pr"
	| "unsupported"
	| "failed";

export interface TaskCapturesSync {
	status: TaskCapturesSyncStatus;
	/** A stable code (`no-credentials`, `pr-unreadable`…), empty when none. */
	reason: string;
	prUrl: string;
	syncedAt?: string;
	hosted: number;
	/** The PR body carries the "Captures" section. */
	section: boolean;
}

export interface TaskCapturesSummary {
	/** Captures were wanted for this task. */
	needed: boolean;
	/** `ui-files`, `no-ui-files`, `forced`, `turned-off`, `no-changed-files`. */
	reason: string;
	/** `task`, `project`, `default`. */
	decidedBy: string;
	/** The interface files that made the decision (20 at most). */
	uiFiles: string[];
	publish: TaskCapturesPublishMode;
	generatedAt?: string;
	items: TaskCaptureItem[];
	publishable: number;
	withheld: number;
	/** In `review` mode: a person published the current copies. */
	approved: boolean;
	sync?: TaskCapturesSync;
}

/** One published copy, for an `<img>`. */
export interface TaskCaptureImage {
	base64: string;
	mimeType: "image/png";
}

/** What an action did: the summary read again, and the runner's refusal if any. */
export interface TaskCapturesActionResult {
	captures?: TaskCapturesSummary;
	sync?: TaskCapturesSync;
	/** No pull request is open for the task's branch yet: nothing was sent. */
	noPr?: boolean;
}
