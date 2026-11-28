import { useEffect, useRef, useState } from "react";
import type { Task } from "../../../shared/types/task";
import {
	type NarrativeEvent,
	narrativeRequestOf,
	narrativesBetween,
} from "../../lib/pixel-office-narratives";

/** Scenes on screen at once; an older one leaves when a new one arrives. */
export const MAX_SCENES = 3;
/** How long a scene stays, in ms. */
export const SCENE_TTL_MS = 30_000;

export interface Scene {
	readonly id: number;
	readonly event: NarrativeEvent;
	/** The model's sentence, once it answered; the template until then. */
	readonly text?: string;
	readonly at: number;
}

interface Options {
	readonly projectId: string;
	/** The project's tasks only. */
	readonly tasks: readonly Task[];
	/** False while the task list is loading: a half list is no transition. */
	readonly ready: boolean;
	readonly enabled: boolean;
	/** Ask the page's model for the sentence (the template shows meanwhile). */
	readonly ai: boolean;
	readonly language: string;
}

/**
 * The mini-scenes of the office: one per task that changed hands since the
 * last reading. The first reading of a project tells nothing, as the chimes
 * stay silent for an agent already waiting when the office opens. A model's
 * answer replaces the template of its own scene, if it is still on screen;
 * a failure leaves the template.
 */
export function useOfficeNarratives({
	projectId,
	tasks,
	ready,
	enabled,
	ai,
	language,
}: Options): Scene[] {
	const [scenes, setScenes] = useState<Scene[]>([]);
	const previous = useRef<{
		projectId: string;
		tasks: Map<string, Task>;
	} | null>(null);
	const nextId = useRef(0);

	useEffect(() => {
		// Another project: its first reading tells nothing, and the scenes go.
		if (previous.current && previous.current.projectId !== projectId) {
			previous.current = null;
			setScenes([]);
		}
		if (!ready) return;
		const before = previous.current?.tasks;
		previous.current = {
			projectId,
			tasks: new Map(tasks.map((task) => [task.id, task])),
		};
		if (!before || !enabled) return;
		const events = narrativesBetween(before, tasks);
		if (events.length === 0) return;
		const at = Date.now();
		const fresh = events.map((event) => ({ id: nextId.current++, event, at }));
		setScenes((list) => [...list, ...fresh].slice(-MAX_SCENES));
		const narrate = ai ? globalThis.electronAPI?.pixelOffice?.narrate : undefined;
		if (!narrate) return;
		for (const scene of fresh) {
			narrate(narrativeRequestOf(scene.event, language)).then(
				(result) => {
					if (!result?.success) return;
					setScenes((list) =>
						list.map((s) => (s.id === scene.id ? { ...s, text: result.text } : s)),
					);
				},
				() => undefined,
			);
		}
	}, [projectId, tasks, ready, enabled, ai, language]);

	useEffect(() => {
		const oldest = scenes[0];
		if (!oldest) return;
		const timer = setTimeout(
			() => setScenes((list) => list.filter((s) => s.id !== oldest.id)),
			Math.max(0, oldest.at + SCENE_TTL_MS - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [scenes]);

	return enabled ? scenes : [];
}
