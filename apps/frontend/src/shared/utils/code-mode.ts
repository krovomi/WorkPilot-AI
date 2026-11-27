/**
 * Code mode (Settings, Code mode): whether agents may chain their tools in a
 * script (`run_script` in the WorkPilot loop). `off` is the product as it was
 * before code mode, and the default; `auto` offers it to the phases where it
 * pays (coding, QA, the analyses of the code); `on` to every agent that has
 * tools. Read again by `apps/backend/code_mode/settings.py`.
 */

export const CODE_MODES = ["off", "auto", "on"] as const;
export type CodeModeSetting = (typeof CODE_MODES)[number];
export const DEFAULT_CODE_MODE: CodeModeSetting = "off";

/** A saved value as the backend will read it: anything unknown is `off`. */
export function normalizeCodeMode(value: unknown): CodeModeSetting {
	return typeof value === "string" && (CODE_MODES as readonly string[]).includes(value)
		? (value as CodeModeSetting)
		: DEFAULT_CODE_MODE;
}

/** The phases a task can give a mode of its own (the backend's `PHASE_OF_AGENT`). */
export const CODE_MODE_PHASES = ["spec", "planning", "coding", "qa"] as const;
export type CodeModePhase = (typeof CODE_MODE_PHASES)[number];

/**
 * A task's own mode per phase, saved as `phaseCodeMode` in its metadata. A
 * phase left out follows Settings; the Settings switch on `off` wins over all.
 */
export type PhaseCodeMode = Partial<Record<CodeModePhase, CodeModeSetting>>;

/** The known phases with a known mode, nothing else. */
export function normalizePhaseCodeMode(value: unknown): PhaseCodeMode {
	const chosen: PhaseCodeMode = {};
	if (!value || typeof value !== "object") return chosen;
	for (const phase of CODE_MODE_PHASES) {
		const mode = (value as Record<string, unknown>)[phase];
		if (typeof mode === "string" && (CODE_MODES as readonly string[]).includes(mode)) {
			chosen[phase] = mode as CodeModeSetting;
		}
	}
	return chosen;
}

/** The same choice, `undefined` when no phase has one (nothing to save). */
export function phaseCodeModeToSave(value: PhaseCodeMode): PhaseCodeMode | undefined {
	const chosen = normalizePhaseCodeMode(value);
	return Object.keys(chosen).length > 0 ? chosen : undefined;
}
