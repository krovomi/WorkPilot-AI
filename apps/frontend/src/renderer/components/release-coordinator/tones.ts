import type { RunStatus } from "../../../shared/types/release-train";
import type { Tone } from "../charter";

export const RUN_TONES: Record<RunStatus, Tone> = {
	running: "blue",
	waiting: "amber",
	blocked: "red",
	done: "green",
	rolled_back: "violet",
	rollback_failed: "red",
	aborted: "muted",
};
