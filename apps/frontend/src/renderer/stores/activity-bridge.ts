import type { StoreApi } from "zustand";
import type { SidebarView } from "@/components/Sidebar";
import {
	dropActivity,
	finishActivity,
	startActivity,
} from "./activity-store";

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
	/** i18n key naming the kind of work, e.g. `navigation:activity.kinds.ideation`. */
	labelKey: string;
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
			startActivity({ id: currentId, view, projectId: project, labelKey });
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
