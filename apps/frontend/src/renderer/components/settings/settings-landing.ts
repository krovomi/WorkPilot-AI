import type { AppSection, ProjectSettingsSection } from "./AppSettings";

export interface SettingsLandingInput {
	/** An app-level section the caller asked for, if any. */
	readonly initialSection?: AppSection;
	/** A project-level section the caller asked for, if any. */
	readonly initialProjectSection?: ProjectSettingsSection;
	/** Whether there is a project for the project pane to render. */
	readonly hasProjectToShow: boolean;
	/** Whether this opening of the dialog has already landed somewhere. */
	readonly hasLanded: boolean;
}

export interface SettingsLanding {
	readonly topLevel: "app" | "project";
	/** Set only when the landing picks an app section. */
	readonly appSection?: AppSection;
	/** Set only when the landing picks a project section. */
	readonly projectSection?: ProjectSettingsSection;
	/**
	 * Whether this landing is final for the current opening. A landing that is
	 * not final is re-decided as soon as its inputs improve — which is the case
	 * for the project pane before the store has resolved a project.
	 */
	readonly landed: boolean;
}

/**
 * Where the settings dialog opens.
 *
 * Extracted from the effect that applies it because the decision has four
 * inputs and one of them arrives late: `hasProjectToShow` flips a tick after a
 * cold open, and the effect therefore re-runs. Without `hasLanded` that re-run
 * would pull the user back to the landing section after they had navigated
 * away — a bug that is invisible in the effect and obvious in a table.
 *
 * `null` means "leave the dialog where it is".
 */
export function resolveSettingsLanding(
	input: SettingsLandingInput,
): SettingsLanding | null {
	const { initialSection, initialProjectSection, hasProjectToShow, hasLanded } =
		input;

	// An explicit target always wins, and always settles the opening: the caller
	// named a section, so a later project resolution has nothing to add.
	if (initialProjectSection) {
		return {
			topLevel: "project",
			projectSection: initialProjectSection,
			landed: true,
		};
	}
	if (initialSection) {
		return { topLevel: "app", appSection: initialSection, landed: true };
	}

	if (hasLanded) return null;

	// No explicit target: this is the global settings entry point, and "Général"
	// is where what someone opens Settings to change actually lives — the
	// repository, its branch, its remote.
	if (hasProjectToShow) {
		return { topLevel: "project", projectSection: "general", landed: true };
	}

	// Nothing to show in the project pane yet. Fall back to the app pane, but do
	// not call it settled: a project resolving a tick later is exactly the case
	// this leaves the door open for.
	return { topLevel: "app", landed: false };
}
