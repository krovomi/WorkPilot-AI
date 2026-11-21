import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Subtask, Task } from "@shared/types";
import { useSettingsStore } from "../../../stores/settings-store";
import { useTaskStore } from "../../../stores/task-store";
import { useVoiceAssistantStore } from "../../../stores/voice-assistant-store";
import { MAX_NARRATIONS, narrate, snapshotTasks, VoiceNarration } from "../voice-narration";
import { installSpeech } from "./speech-fake";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			`${key}|${String(values?.title)}|${String(values?.detail)}`,
		i18n: { language: "fr" },
	}),
}));

const subtask = (id: string, status: Subtask["status"], title = `Sub ${id}`): Subtask => ({
	id,
	title,
	status,
	description: "",
	files: [],
});

const task = (over: Partial<Task> = {}): Task =>
	({
		id: "t1",
		specId: "001-export",
		projectId: "p1",
		title: "Export CSV",
		description: "",
		status: "in_progress",
		subtasks: [subtask("s1", "pending"), subtask("s2", "pending")],
		logs: [],
		executionProgress: { phase: "planning", phaseProgress: 0, overallProgress: 0 },
		...over,
	}) as Task;

const keys = (lines: { key: string }[]) => lines.map((line) => line.key);

describe("what changed in a task", () => {
	it("says nothing for a task seen for the first time, or that did not change", () => {
		expect(narrate(new Map(), [task()], "t1")).toEqual([]);
		expect(narrate(snapshotTasks([task()]), [task()], "t1")).toEqual([]);
	});

	it("says each new phase it names, not the others", () => {
		const before = snapshotTasks([task()]);
		expect(narrate(before, [task({ executionProgress: { phase: "coding", phaseProgress: 0, overallProgress: 0 } })], null)).toEqual([
			{ taskId: "t1", key: "phase.coding", title: "Export CSV" },
		]);
		expect(narrate(before, [task({ executionProgress: { phase: "idle", phaseProgress: 0, overallProgress: 0 } })], null)).toEqual([]);
		expect(narrate(before, [task({ executionProgress: undefined })], null)).toEqual([]);
	});

	it("says how a task ended, once, instead of its phase", () => {
		const before = snapshotTasks([task()]);
		const ended = (over: Partial<Task>) =>
			keys(narrate(before, [task({ executionProgress: { phase: "complete", phaseProgress: 0, overallProgress: 100 }, ...over })], null));
		expect(ended({ status: "human_review", reviewReason: "plan_review" })).toEqual(["planReview"]);
		expect(ended({ status: "human_review", reviewReason: "completed" })).toEqual(["review"]);
		expect(ended({ status: "human_review", reviewReason: "qa_rejected" })).toEqual(["review"]);
		expect(ended({ status: "human_review", reviewReason: "errors" })).toEqual(["failed"]);
		expect(ended({ status: "human_review", reviewReason: "prompt_too_long" })).toEqual(["failed"]);
		expect(ended({ status: "human_review", reviewReason: "stopped" })).toEqual(["stopped"]);
		expect(ended({ status: "error" })).toEqual(["failed"]);
		expect(ended({ status: "build_failed" })).toEqual(["failed"]);
		expect(ended({ status: "done" })).toEqual(["done"]);
		expect(ended({ status: "pr_created" })).toEqual(["done"]);
		expect(ended({ status: "ai_review" })).toEqual([]);
		// The same review, a new reason: said again.
		const review = snapshotTasks([task({ status: "human_review", reviewReason: "plan_review" })]);
		expect(keys(narrate(review, [task({ status: "human_review", reviewReason: "completed" })], null))).toEqual([
			"review",
		]);
	});

	it("says the followed task's subtasks, started and finished, with the spec id when untitled", () => {
		const before = snapshotTasks([task()]);
		const now = task({
			title: "",
			subtasks: [subtask("s1", "completed", "Parse the rows"), subtask("s2", "in_progress", "")],
			executionProgress: { phase: "planning", phaseProgress: 0, overallProgress: 0, currentSubtask: "s2" },
		});
		expect(narrate(before, [now], "t1")).toEqual([
			{ taskId: "t1", key: "subtaskDone", title: "001-export", detail: "Parse the rows" },
			{ taskId: "t1", key: "working", title: "001-export", detail: "s2" },
		]);
		expect(narrate(before, [now], null)).toEqual([]);
		const known = task({ executionProgress: { phase: "planning", phaseProgress: 0, overallProgress: 0, currentSubtask: "s1" } });
		expect(narrate(before, [known], "t1")).toEqual([
			{ taskId: "t1", key: "working", title: "Export CSV", detail: "Sub s1" },
		]);
	});

	it("reads a task without subtasks", () => {
		const bare = task({ subtasks: undefined as unknown as Task["subtasks"] });
		expect(snapshotTasks([bare]).get("t1")?.done).toBe(0);
		expect(narrate(snapshotTasks([bare]), [bare], "t1")).toEqual([]);
		const working = task({
			subtasks: undefined as unknown as Task["subtasks"],
			executionProgress: { phase: "planning", phaseProgress: 0, overallProgress: 0, currentSubtask: "s9" },
		});
		expect(narrate(snapshotTasks([bare]), [working], "t1")).toEqual([
			{ taskId: "t1", key: "working", title: "Export CSV", detail: "s9" },
		]);
	});
});

describe("the narration, mounted", () => {
	let speech: ReturnType<typeof installSpeech>;
	const coding = (id = "t1") =>
		task({ id, executionProgress: { phase: "coding", phaseProgress: 0, overallProgress: 0 } });

	beforeEach(() => {
		speech = installSpeech();
		useTaskStore.setState({ tasks: [task(), task({ id: "t2" })] });
		useVoiceAssistantStore.setState({ continuous: false, pairTaskId: null, pairNarration: "" });
		useSettingsStore.setState((state) => ({ settings: { ...state.settings, voiceAssistantFeedback: "off" } }));
	});
	afterEach(() => {
		for (const utterance of speech.spoken) utterance.onend?.();
		speech.uninstall();
	});

	it("listens to nothing when spoken feedback is not verbose and no task is followed", () => {
		render(<VoiceNarration />);
		act(() => useTaskStore.setState({ tasks: [coding(), task({ id: "t2" })] }));
		expect(speech.said()).toEqual([]);
	});

	it("says what every task does when verbose, a few lines at most", () => {
		useSettingsStore.setState((state) => ({ settings: { ...state.settings, voiceAssistantFeedback: "verbose" } }));
		render(<VoiceNarration />);
		act(() => useTaskStore.setState({ tasks: [coding(), coding("t2")] }));
		expect(speech.said()).toEqual([
			"voiceAssistant:narration.phase.coding|Export CSV|",
			"voiceAssistant:narration.phase.coding|Export CSV|",
		]);
		expect(speech.spoken[0].lang).toBe("fr");
		const many = Array.from({ length: MAX_NARRATIONS + 2 }, (_, i) => task({ id: `m${i}` }));
		act(() => useTaskStore.setState({ tasks: many }));
		act(() => useTaskStore.setState({ tasks: many.map((t) => coding(t.id)) }));
		expect(speech.said()).toHaveLength(2 + MAX_NARRATIONS);
	});

	it("follows one task in pair mode: shows its lines, and says them unless feedback is off", () => {
		useVoiceAssistantStore.setState({ continuous: true, pairTaskId: "t1" });
		render(<VoiceNarration />);
		act(() => useTaskStore.setState({ tasks: [coding(), coding("t2")] }));
		expect(useVoiceAssistantStore.getState().pairNarration).toBe("voiceAssistant:narration.phase.coding|Export CSV|");
		expect(speech.said()).toEqual([]);
		act(() =>
			useSettingsStore.setState((state) => ({ settings: { ...state.settings, voiceAssistantFeedback: "short" } })),
		);
		act(() => useTaskStore.setState({ tasks: [task({ status: "done" }), task({ id: "t2", status: "done" })] }));
		// Short: the followed task only.
		expect(speech.said()).toEqual(["voiceAssistant:narration.done|Export CSV|"]);
	});
});
