import { create } from "zustand";
import type { SidebarView } from "@/components/Sidebar";

/**
 * One registry for "something is happening on a page the user is not looking
 * at". Every page of the left menu can register work here; the sidebar, the
 * toasts and the background indicator all read this one store rather than each
 * feature inventing its own signal.
 *
 * The mental model is unread mail, not notification: a finished job leaves a
 * silent mark that survives navigation and clears when the page is visited.
 * Blinking is a *transition*, never a *state* — see `attention` below.
 */

export type ActivityStatus = "running" | "success" | "error";

export interface Activity {
	/** Stable per unit of work, e.g. `ideation:<projectId>` or `task:<id>`. */
	id: string;
	/** The menu entry this work belongs to — the link to the sidebar badge. */
	view: SidebarView;
	/** Null for deployment-scoped work (the administration console). */
	projectId: string | null;
	/** i18n key for what the job is, e.g. `navigation:activity.kinds.build`. */
	labelKey: string;
	/** Free text that must not be translated (a task title, a branch name). */
	label?: string;
	status: ActivityStatus;
	startedAt: number;
	endedAt?: number;
	/** Whether the user has visited the page since the job reached its end. */
	seen: boolean;
	/** First line of the failure, shown in the toast and the activity centre. */
	detail?: string;
}

/**
 * How long a badge animates after a job finishes. Long enough to catch the eye
 * on a glance, short enough that a user who looks up two seconds later sees a
 * still sidebar rather than one that is still blinking at them.
 */
export const ATTENTION_MS = 2500;

/** Finished activities kept for the activity centre before the oldest is cut. */
const MAX_FINISHED = 50;

interface AttentionToken {
	view: SidebarView;
	status: ActivityStatus;
	at: number;
}

interface ActivityState {
	activities: Activity[];
	/**
	 * The page currently on screen. Work that ends here is read as it lands —
	 * badging the entry the user is already looking at is noise.
	 */
	activeView: SidebarView | null;
	/**
	 * At most one entry animates at any moment, and only the one that just
	 * changed. Two pages finishing together produce one animation and one
	 * silent badge, which is the whole difference between a signal and a
	 * light show.
	 */
	attention: AttentionToken | null;

	start: (
		activity: Omit<Activity, "status" | "startedAt" | "seen" | "endedAt">,
	) => void;
	finish: (
		id: string,
		status: Exclude<ActivityStatus, "running">,
		detail?: string,
	) => void;
	/** Drop a job without any trace — it was cancelled, not finished. */
	drop: (id: string) => void;
	/** The user is now looking at this page: its badge has been read. */
	markViewSeen: (view: SidebarView) => void;
	setActiveView: (view: SidebarView | null) => void;
	clearAttention: () => void;
}

let attentionTimer: ReturnType<typeof setTimeout> | null = null;

const SEVERITY: Record<ActivityStatus, number> = {
	running: 0,
	success: 1,
	error: 2,
};

function pruneFinished(activities: Activity[]): Activity[] {
	const finished = activities.filter((a) => a.status !== "running");
	if (finished.length <= MAX_FINISHED) return activities;

	const cutoff = finished
		.map((a) => a.endedAt ?? a.startedAt)
		.sort((a, b) => b - a)[MAX_FINISHED - 1];

	return activities.filter(
		(a) => a.status === "running" || (a.endedAt ?? a.startedAt) >= cutoff,
	);
}

export const useActivityStore = create<ActivityState>((set, get) => ({
	activities: [],
	activeView: null,
	attention: null,

	start: (activity) =>
		set((state) => {
			const next: Activity = {
				...activity,
				status: "running",
				startedAt: Date.now(),
				seen: false,
			};
			// Re-running the same unit of work replaces its previous record: the
			// page shows one line per job, not one per attempt.
			const without = state.activities.filter((a) => a.id !== activity.id);
			return { activities: pruneFinished([...without, next]) };
		}),

	finish: (id, status, detail) => {
		const existing = get().activities.find((a) => a.id === id);
		// A completion for work nobody registered is not an error worth raising,
		// but it must not conjure a badge out of nothing either.
		if (!existing) return;

		// Landing on the page the user is watching is already visible: no badge,
		// no animation, and the toast alone says it happened.
		const isWatched = existing.view === get().activeView;

		set((state) => ({
			activities: pruneFinished(
				state.activities.map((a) =>
					a.id === id
						? {
								...a,
								status,
								detail,
								endedAt: Date.now(),
								seen: isWatched,
							}
						: a,
				),
			),
		}));

		if (!isWatched) requestAttention(existing.view, status);
	},

	drop: (id) =>
		set((state) => ({
			activities: state.activities.filter((a) => a.id !== id),
		})),

	markViewSeen: (view) =>
		set((state) => ({
			activities: state.activities.map((a) =>
				a.view === view && !a.seen ? { ...a, seen: true } : a,
			),
			// Visiting the page answers whatever the animation was asking.
			attention: state.attention?.view === view ? null : state.attention,
		})),

	setActiveView: (view) => {
		set({ activeView: view });
		if (view) get().markViewSeen(view);
	},

	clearAttention: () => set({ attention: null }),
}));

/**
 * Hands the single animation slot to `view`, unless a more severe one is
 * already using it: a build failure keeps the eye it earned when a routine
 * success lands a moment later.
 */
function requestAttention(view: SidebarView, status: ActivityStatus): void {
	const current = useActivityStore.getState().attention;
	if (current && SEVERITY[current.status] > SEVERITY[status]) return;

	if (attentionTimer) clearTimeout(attentionTimer);
	useActivityStore.setState({ attention: { view, status, at: Date.now() } });

	attentionTimer = setTimeout(() => {
		attentionTimer = null;
		useActivityStore.getState().clearAttention();
	}, ATTENTION_MS);
}

export interface ViewBadge {
	/** The severity to paint: the worst unseen state on that page. */
	status: ActivityStatus;
	/** How many activities are in that state — rendered only when above 1. */
	count: number;
	/**
	 * The one it stands for, when it stands for exactly one. It is what lets
	 * the badge name the job on hover instead of only counting it.
	 */
	activity?: Activity;
}

/**
 * What a single menu entry should show, or null for "say nothing".
 *
 * `projectId` scopes the answer: work on another project's checkout must not
 * badge the menu of the project on screen — that belongs on the project tab.
 */
export function selectViewBadge(
	activities: Activity[],
	view: SidebarView,
	projectId: string | null,
): ViewBadge | null {
	let worst: ActivityStatus | null = null;
	let count = 0;
	let representative: Activity | undefined;

	for (const activity of activities) {
		if (activity.view !== view) continue;
		if (activity.projectId !== null && activity.projectId !== projectId) {
			continue;
		}
		// A finished job the user has already looked at is history, not a badge.
		if (activity.status !== "running" && activity.seen) continue;

		if (!worst || SEVERITY[activity.status] > SEVERITY[worst]) {
			worst = activity.status;
			count = 1;
			representative = activity;
		} else if (activity.status === worst) {
			count += 1;
		}
	}

	return worst ? { status: worst, count, activity: representative } : null;
}

/** The same answer for a collapsed group: the worst state among its entries. */
export function selectGroupBadge(
	activities: Activity[],
	views: readonly SidebarView[],
	projectId: string | null,
): ViewBadge | null {
	let worst: ActivityStatus | null = null;
	let count = 0;
	let representative: Activity | undefined;

	for (const view of views) {
		const badge = selectViewBadge(activities, view, projectId);
		if (!badge) continue;
		if (!worst || SEVERITY[badge.status] > SEVERITY[worst]) {
			worst = badge.status;
			count = badge.count;
			representative = badge.activity;
		} else if (badge.status === worst) {
			count += badge.count;
		}
	}

	return worst ? { status: worst, count, activity: representative } : null;
}

/** Everything still running, newest first — the activity centre's list. */
export function selectRunning(activities: Activity[]): Activity[] {
	return activities
		.filter((a) => a.status === "running")
		.sort((a, b) => b.startedAt - a.startedAt);
}

// Imperative helpers, so a store that is not a React component can report its
// own work without importing the hook.
export const startActivity = (
	activity: Parameters<ActivityState["start"]>[0],
): void => useActivityStore.getState().start(activity);

export const finishActivity = (
	id: string,
	status: Exclude<ActivityStatus, "running">,
	detail?: string,
): void => useActivityStore.getState().finish(id, status, detail);

export const dropActivity = (id: string): void =>
	useActivityStore.getState().drop(id);

export const setActivityActiveView = (view: SidebarView | null): void =>
	useActivityStore.getState().setActiveView(view);

/**
 * The single entry allowed to animate right now, or null.
 *
 * Badges themselves are derived from `activities` by the caller rather than by
 * a selector hook: a selector that built the badge object inside
 * `useActivityStore` would return a new identity on every store change, and
 * the sidebar renders one badge per menu entry.
 */
export function useAttentionView(): SidebarView | null {
	return useActivityStore((state) => state.attention?.view ?? null);
}
