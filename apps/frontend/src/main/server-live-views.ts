/**
 * The shared views of a server project, live (server mode). While a window
 * shows a server project's roadmap, ideas, Insights conversations or
 * context, it holds the project's stream (`server-project-stream.ts`, the
 * same socket as the board) and is told which view a teammate changed. The
 * view then reads itself again through its usual handlers, which read the
 * feature's files fresh from the server into the mirror
 * (`ipc-handlers/server-feature-files.ts`): nothing of the event's content
 * reaches the window, only which view to read.
 *
 * One reference per shown view: the stream stays open while any view of the
 * project is shown in a window (a view shown twice counts twice), and closes
 * with the last. A change the person made is not sent back: the window that
 * made it already shows it.
 */

import type { ServerLiveView, ServerViewChange } from "../shared/types";
import { getAuthState } from "./server-connection";
import { holdProjectStream, type StreamEvent } from "./server-project-stream";
import { getServerProject } from "./server-projects";

export const LIVE_VIEWS: ReadonlySet<ServerLiveView> = new Set<ServerLiveView>([
	"roadmap",
	"ideation",
	"insights",
	"context",
]);

/**
 * The stream's events a shared view follows, each a type of the server's
 * stream (`streaming_manager.EventType`; `tests/backend/test_live_feature_events.py`).
 */
export const LIVE_VIEW_EVENTS = [
	"feature_updated",
	"feature_job",
	"insights_updated",
	"spec_status_changed",
] as const;

/** The features whose files a view mirrors (`shared_features/registry.py`). */
const FILE_FEATURES: ReadonlySet<string> = new Set(["roadmap", "ideation", "context"]);
const FINAL_RUN = new Set(["succeeded", "failed", "cancelled"]);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const CHANGE_DEBOUNCE_MS = 300;

type Notify = (change: ServerViewChange) => void;

/** One window's hold on one project's stream, with a count per view. */
interface Hold {
	projectId: string;
	counts: Map<ServerLiveView, number>;
	notify: Notify;
	release: (() => void) | null;
	dropped: boolean;
	pending: Map<string, ServerViewChange>;
	timer: ReturnType<typeof setTimeout> | null;
}

/** By window, then by project. */
const holds = new Map<number, Map<string, Hold>>();

function isLiveView(value: unknown): value is ServerLiveView {
	return typeof value === "string" && LIVE_VIEWS.has(value as ServerLiveView);
}

/**
 * The view an event of the stream changes, or null: an event of no shared
 * view, or one the person caused (`me`). Only names from closed lists pass.
 */
export function viewChange(
	projectId: string,
	event: StreamEvent,
	me: string | null,
): ServerViewChange | null {
	const { type, data } = event;
	if (type === "spec_status_changed") {
		// A run of the project ended: the agents may have learned something.
		return typeof data.run_status === "string" && FINAL_RUN.has(data.run_status)
			? { projectId, view: "context", memoriesOnly: true }
			: null;
	}
	if (me && data.by === me) return null;
	if (type === "feature_updated" || type === "feature_job") {
		const feature = data.feature;
		return typeof feature === "string" && FILE_FEATURES.has(feature)
			? { projectId, view: feature as ServerLiveView }
			: null;
	}
	if (type === "insights_updated") {
		const sessionId = data.session_id;
		return typeof sessionId === "string" && SESSION_ID.test(sessionId)
			? { projectId, view: "insights", sessionId }
			: { projectId, view: "insights" };
	}
	return null;
}

function queue(hold: Hold, change: ServerViewChange): void {
	const key = `${change.view}:${change.sessionId ?? ""}:${change.memoriesOnly ? 1 : 0}`;
	hold.pending.set(key, change);
	if (hold.timer) clearTimeout(hold.timer);
	hold.timer = setTimeout(() => {
		hold.timer = null;
		const changes = [...hold.pending.values()];
		hold.pending.clear();
		for (const pending of changes) {
			if (hold.counts.has(pending.view)) hold.notify(pending);
		}
	}, CHANGE_DEBOUNCE_MS);
}

function forget(owner: number, hold: Hold): void {
	const mine = holds.get(owner);
	if (mine?.get(hold.projectId) === hold) mine.delete(hold.projectId);
	if (mine && mine.size === 0) holds.delete(owner);
	if (hold.timer) clearTimeout(hold.timer);
	hold.timer = null;
	hold.pending.clear();
	hold.counts.clear();
	hold.release?.();
	hold.release = null;
}

/**
 * Follow a shared view of a server project for a window (`owner`): one more
 * reference on the project's stream. False for a view not in the list or a
 * project that is not the server's.
 */
export function watchServerView(
	owner: number,
	projectId: unknown,
	view: unknown,
	notify: Notify,
): boolean {
	if (!Number.isInteger(owner) || !isLiveView(view)) return false;
	if (typeof projectId !== "string" || !getServerProject(projectId)) return false;
	let mine = holds.get(owner);
	let hold = mine?.get(projectId);
	if (!hold) {
		const created: Hold = {
			projectId,
			counts: new Map(),
			notify,
			release: null,
			dropped: false,
			pending: new Map(),
			timer: null,
		};
		const release = holdProjectStream(projectId, {
			onLive: (live) => {
				if (!live) {
					created.dropped = true;
					return;
				}
				if (!created.dropped) return;
				// Back after a drop: what changed meanwhile is read again.
				created.dropped = false;
				for (const shown of created.counts.keys()) {
					queue(created, { projectId, view: shown });
				}
			},
			onEvent: (event) => {
				const change = viewChange(projectId, event, getAuthState().user?.id ?? null);
				if (change && created.counts.has(change.view)) queue(created, change);
			},
		});
		if (!release) return false;
		created.release = release;
		hold = created;
		if (!mine) {
			mine = new Map();
			holds.set(owner, mine);
		}
		mine.set(projectId, hold);
	}
	hold.notify = notify;
	hold.counts.set(view, (hold.counts.get(view) ?? 0) + 1);
	return true;
}

/** One reference fewer; the last of a window's views of a project releases its stream. */
export function unwatchServerView(owner: number, projectId: unknown, view: unknown): void {
	if (typeof projectId !== "string" || !isLiveView(view)) return;
	const hold = holds.get(owner)?.get(projectId);
	const count = hold?.counts.get(view);
	if (!hold || !count) return;
	if (count > 1) hold.counts.set(view, count - 1);
	else hold.counts.delete(view);
	if (hold.counts.size === 0) forget(owner, hold);
}

/** Everything a window followed (it closed). */
export function unwatchWindowViews(owner: number): void {
	for (const hold of [...(holds.get(owner)?.values() ?? [])]) forget(owner, hold);
}

/** Everything every window followed (sign-out, another server). */
export function unwatchAllServerViews(): void {
	for (const owner of [...holds.keys()]) unwatchWindowViews(owner);
}

/** The views a window follows on a project, with their counts (tests, diagnostics). */
export function watchedViews(owner: number, projectId: string): Record<string, number> {
	return Object.fromEntries(holds.get(owner)?.get(projectId)?.counts ?? []);
}
