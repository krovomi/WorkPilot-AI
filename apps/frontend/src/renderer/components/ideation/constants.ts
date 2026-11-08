import type { IdeationType } from "../../../shared/types";
import type { Tone } from "../charter";

// All ideation types for iteration
// Note: high_value_features removed - strategic features belong to Roadmap
export const ALL_IDEATION_TYPES: IdeationType[] = [
	"code_improvements",
	"ui_ux_improvements",
	"documentation_gaps",
	"security_hardening",
	"performance_optimizations",
	"code_quality",
];

/** The charter tone of each ideation type (chips, card rails, tabs). */
export const IDEATION_TYPE_TONES: Record<IdeationType, Tone> = {
	code_improvements: "green",
	ui_ux_improvements: "blue",
	documentation_gaps: "amber",
	security_hardening: "red",
	performance_optimizations: "violet",
	code_quality: "accent",
};

/** The tone of an idea's effort, impact or severity level. */
export const IDEA_LEVEL_TONES: Record<string, Tone> = {
	trivial: "green",
	small: "blue",
	suggestion: "blue",
	low: "muted",
	medium: "amber",
	minor: "amber",
	large: "orange",
	high: "orange",
	major: "orange",
	complex: "red",
	critical: "red",
};

/** The tone of an idea's status. */
export const IDEA_STATUS_TONES: Record<string, Tone> = {
	draft: "muted",
	selected: "accent",
	converted: "green",
	dismissed: "red",
	archived: "violet",
};
