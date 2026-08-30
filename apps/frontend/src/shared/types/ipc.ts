/**
 * IPC (Inter-Process Communication) types for Electron API
 */

import type { ElectronAPI as ComposedElectronAPI } from "../../preload/api";

// ============================================
// Branch Types
// ============================================

/**
 * Branch type indicator for distinguishing local from remote branches
 */
export type GitBranchType = "local" | "remote";

/**
 * Structured branch information for UI display with type indicators
 * Used in branch selection dropdowns to distinguish local vs remote branches
 */
export interface GitBranchDetail {
	/** The branch name (e.g., 'main', 'origin/main') */
	name: string;
	/** Whether this is a local or remote branch */
	type: GitBranchType;
	/** Display name for UI (e.g., 'main' for local, 'origin/main' for remote) */
	displayName: string;
	/** Whether this is the currently checked out branch */
	isCurrent?: boolean;
}

// ============================================
// Electron API
// ============================================

// Electron API exposed via contextBridge
// Tab state interface (persisted in the main process)
export interface TabState {
	openProjectIds: string[];
	activeProjectId: string | null;
	tabOrder: string[];
}

/**
 * Ce que le preload expose reellement au renderer.
 *
 * Le corps de cette interface etait maintenu a la main et avait derive : il
 * declarait 356 membres la ou le preload en compose plus de 660, et portait un
 * index signature `[x: string]: any` qui faisait compiler n'importe quel acces —
 * y compris sur les ponts fantomes que la PR #72 a du trouver a la main.
 *
 * La source de verite est desormais le type que `createElectronAPI()` compose a
 * partir de ses 83 modules : exact par construction, puisque c'est litteralement
 * ce qui traverse `contextBridge`. Meme sens de dependance que
 * `phase35-electron-api.d.ts` avant lui, et que les stores du renderer qui
 * importent deja leurs types depuis `preload/api/modules/*`.
 *
 * `import type` est efface a la compilation : rien d'`electron` n'entre dans le
 * bundle du renderer.
 */
export interface ElectronAPI extends ComposedElectronAPI {}

/** Platform information exposed via contextBridge for platform-specific behavior */
export interface PlatformInfo {
	isWindows: boolean;
	isMacOS: boolean;
	isLinux: boolean;
	isUnix: boolean;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
		DEBUG?: boolean;
		platform?: PlatformInfo;
	}
}
