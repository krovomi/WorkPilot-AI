import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@shared/types";
import { useSettingsStore } from "../../stores/settings-store";
import { useTaskStore } from "../../stores/task-store";
import { useVoiceAssistantStore } from "../../stores/voice-assistant-store";
import { speak, speaksAt, voiceFeedback } from "./voice-speech";

/**
 * What the running tasks do, said aloud (issue #385): « Export CSV: coding »,
 * « Export CSV: ready for review ». Read from the task store the board already
 * keeps up to date, by comparing each update with the one before: no IPC
 * listener of its own, no new event from the backend.
 *
 * Spoken feedback « verbose » says the phases and outcomes of every task of
 * the project. Pair mode follows one task (`pairTaskId`) and also says the
 * subtask it starts and each one it finishes, even with « short ».
 */

interface Snapshot {
	status: Task["status"];
	reviewReason?: Task["reviewReason"];
	phase?: string;
	subtask?: string;
	done: number;
}

export interface Narration {
	taskId: string;
	/** Under `voiceAssistant:narration.` */
	key: string;
	title: string;
	detail?: string;
}

const SPOKEN_PHASES = new Set(["planning", "coding", "qa_review", "qa_fixing", "rate_limit_paused"]);
/** A burst of updates says this much at most. */
export const MAX_NARRATIONS = 3;

export function snapshotTasks(tasks: readonly Task[]): Map<string, Snapshot> {
	const snapshots = new Map<string, Snapshot>();
	for (const task of tasks) {
		snapshots.set(task.id, {
			status: task.status,
			reviewReason: task.reviewReason,
			phase: task.executionProgress?.phase,
			subtask: task.executionProgress?.currentSubtask,
			done: task.subtasks?.filter((s) => s.status === "completed").length ?? 0,
		});
	}
	return snapshots;
}

function outcome(task: Task): string | null {
	switch (task.status) {
		case "human_review":
			if (task.reviewReason === "plan_review") return "planReview";
			if (task.reviewReason === "errors" || task.reviewReason === "prompt_too_long") return "failed";
			if (task.reviewReason === "stopped") return "stopped";
			return "review";
		case "error":
		case "build_failed":
			return "failed";
		case "done":
		case "pr_created":
			return "done";
		default:
			return null;
	}
}

function subtaskTitle(task: Task, id: string): string {
	return task.subtasks?.find((s) => s.id === id)?.title || id;
}

/**
 * The lines to say for what changed between two snapshots. A task seen for
 * the first time (another project opened) says nothing.
 */
export function narrate(
	before: ReadonlyMap<string, Snapshot>,
	tasks: readonly Task[],
	followed: string | null,
): Narration[] {
	const lines: Narration[] = [];
	for (const task of tasks) {
		const was = before.get(task.id);
		if (!was) continue;
		const title = task.title || task.specId;
		const phase = task.executionProgress?.phase;
		const end = was.status !== task.status || was.reviewReason !== task.reviewReason ? outcome(task) : null;
		if (end) {
			lines.push({ taskId: task.id, key: end, title });
			continue;
		}
		if (phase && phase !== was.phase && SPOKEN_PHASES.has(phase))
			lines.push({ taskId: task.id, key: `phase.${phase}`, title });
		if (task.id !== followed) continue;
		const done = task.subtasks?.filter((s) => s.status === "completed") ?? [];
		if (done.length > was.done)
			lines.push({
				taskId: task.id,
				key: "subtaskDone",
				title,
				detail: done[done.length - 1]?.title,
			});
		const subtask = task.executionProgress?.currentSubtask;
		if (subtask && subtask !== was.subtask)
			lines.push({ taskId: task.id, key: "working", title, detail: subtaskTitle(task, subtask) });
	}
	return lines;
}

/**
 * Mounted once with the assistant (`VoiceAssistant.tsx`): says the lines the
 * setting asks for, and keeps the followed task's last one for the pair bar.
 */
export function useTaskNarration(): void {
	const { t, i18n } = useTranslation(["voiceAssistant"]);
	const feedback = voiceFeedback(useSettingsStore((s) => s.settings.voiceAssistantFeedback));
	const followed = useVoiceAssistantStore((s) => (s.continuous ? s.pairTaskId : null));

	useEffect(() => {
		if (feedback !== "verbose" && !followed) return;
		let before = snapshotTasks(useTaskStore.getState().tasks);
		return useTaskStore.subscribe((state) => {
			const lines = narrate(before, state.tasks, followed);
			before = snapshotTasks(state.tasks);
			for (const line of lines.slice(0, MAX_NARRATIONS)) {
				const text = t(`voiceAssistant:narration.${line.key}`, {
					title: line.title,
					detail: line.detail ?? "",
				});
				const mine = line.taskId === followed;
				if (mine) useVoiceAssistantStore.setState({ pairNarration: text });
				if (speaksAt(feedback, mine ? "short" : "verbose")) speak(text, i18n.language);
			}
		});
	}, [feedback, followed, t, i18n.language]);
}

/** The narration, mounted once beside the assistant's panel. */
export function VoiceNarration(): null {
	useTaskNarration();
	return null;
}
