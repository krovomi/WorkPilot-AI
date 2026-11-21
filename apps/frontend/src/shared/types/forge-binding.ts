/**
 * A project's forge settings checked against its git remotes
 * (`main/forge/project-forge-binding.ts`).
 */

import type { ProjectEnvConfig } from "./project";

/**
 * - `matched`: the saved repository is one of the project's remotes.
 * - `detected`: nothing saved; the project's remote is used.
 * - `mismatch`: the saved repository is none of the project's remotes.
 * - `unverified`: something is saved, but there is nothing to compare it with
 *   (no remote at all, or a GitLab numeric project id).
 * - `none`: nothing saved and no remote on that forge.
 */
export type ForgeBindingStatus =
	| "matched"
	| "detected"
	| "mismatch"
	| "unverified"
	| "none";

/** A repository one of the project's remotes names, and the settings that select it. */
export interface ForgeBindingCandidate {
	label: string;
	fix: Partial<ProjectEnvConfig>;
}

export interface ForgeBinding {
	status: ForgeBindingStatus;
	/** What the project's settings name, normalized for display. */
	saved: string | null;
	candidates: ForgeBindingCandidate[];
}

export interface ProjectForgeBindings {
	github: ForgeBinding;
	gitlab: ForgeBinding;
	azureDevOps: ForgeBinding;
}
