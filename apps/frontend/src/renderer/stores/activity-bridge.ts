import type { StoreApi } from "zustand";
import type { SidebarView } from "@/components/Sidebar";
import {
	dropActivity,
	finishActivity,
	startActivity,
} from "./activity-store";
import { useProjectStore } from "./project-store";

/**
 * What a feature store says about its own work, in the only four words the
 * activity registry understands.
 *
 * `idle` after `running` means the job stopped without producing anything —
 * cancelled, or reset. That is not a result, so it leaves no badge.
 */
export type FeaturePhase = "idle" | "running" | "success" | "error";

interface BridgeOptions<T> {
	/** The menu entry this store's work belongs to. */
	view: SidebarView;
	/**
	 * i18n key naming the kind of work. A function when the store's own phase
	 * is what names it (`scanning`, `analyzing`…), read when the work starts.
	 */
	labelKey: string | ((state: T) => string);
	/** Where the store keeps the project its current work belongs to. */
	projectId: (state: T) => string | null;
	phase: (state: T) => FeaturePhase;
	/** First line of the failure, when the store has one to give. */
	detail?: (state: T) => string | undefined;
}

/**
 * Mirrors a feature store's own phase into the activity registry, so the
 * sidebar can speak for a page nobody is looking at.
 *
 * Derived from state rather than wired into each action on purpose: a store
 * typically starts its work from three or four entry points (generate, refresh,
 * append…) and ends it from as many event handlers. Hooking every one of them
 * is how a feature ends up badging on success and staying silent on the
 * timeout path.
 */
export function bridgeActivity<T>(
	store: StoreApi<T>,
	options: BridgeOptions<T>,
): () => void {
	const { view, labelKey, projectId, phase, detail } = options;

	let currentId: string | null = null;

	const apply = (state: T) => {
		const next = phase(state);

		if (next === "running") {
			if (currentId) return;
			const project = projectId(state);
			currentId = `${view}:${project ?? "global"}`;
			startActivity({
				id: currentId,
				view,
				projectId: project,
				labelKey: typeof labelKey === "function" ? labelKey(state) : labelKey,
			});
			return;
		}

		if (!currentId) return;

		const id = currentId;
		currentId = null;

		if (next === "idle") {
			dropActivity(id);
			return;
		}

		finishActivity(id, next, detail?.(state));
	};

	apply(store.getState());
	return store.subscribe(apply);
}

/**
 * The phase vocabulary nineteen feature stores already share:
 * `idle | <one verb> | complete | error`. They were written independently and
 * converged on it, which is what makes one bridge enough for all of them.
 */
const TERMINAL_PHASES: Record<string, FeaturePhase> = {
	idle: "idle",
	complete: "success",
	// `code-playground` says `ready` where the others say `complete`.
	ready: "success",
	// `architecture-visualizer` runs a readiness probe on every page open and
	// calls it `checking`. It is not work the user started, and badging the menu
	// for it would put a spinner on the entry every time the page is opened.
	checking: "idle",
	error: "error",
};

/**
 * Bridges a store shaped like `{ phase, error }` without asking it to know
 * anything about the sidebar.
 *
 * The label comes from the running phase itself — `scanning`, `analyzing`,
 * `generating`, `optimizing` — rather than from the feature's name: the badge
 * already sits on the menu entry that names the feature, so "Doc Drift — Doc
 * Drift" was the alternative.
 *
 * The project is read from the project store, because none of these stores
 * keeps one: they take a path as an argument to their start action and forget
 * it.
 */
export function bridgePhaseActivity<
	T extends { phase: string; error?: string | null },
>(store: StoreApi<T>, view: SidebarView): () => void {
	return bridgeActivity(store, {
		view,
		labelKey: (state) => `navigation:activity.kinds.${state.phase}`,
		projectId: () => useProjectStore.getState().selectedProjectId,
		phase: (state) => TERMINAL_PHASES[state.phase] ?? "running",
		detail: (state) => state.error ?? undefined,
	});
}
