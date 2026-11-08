import type { Tone } from "../charter";

/** MoSCoW priority of a roadmap feature, as a charter tone. */
export const ROADMAP_PRIORITY_TONES: Record<string, Tone> = {
	must: "red",
	should: "amber",
	could: "blue",
	wont: "muted",
};

export const ROADMAP_PRIORITIES = ["must", "should", "could", "wont"] as const;
