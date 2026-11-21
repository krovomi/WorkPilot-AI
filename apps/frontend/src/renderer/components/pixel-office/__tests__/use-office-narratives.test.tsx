import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../../shared/types/task";
import {
	MAX_SCENES,
	SCENE_TTL_MS,
	useOfficeNarratives,
} from "../use-office-narratives";

function task(id: string, status: Task["status"], phase?: string): Task {
	return {
		id,
		specId: `00${id}-x`,
		projectId: "p",
		title: `Task ${id}`,
		description: "",
		status,
		subtasks: [],
		logs: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		executionProgress: phase ? ({ phase } as Task["executionProgress"]) : undefined,
	};
}

const narrate = vi.fn();
const api = globalThis as unknown as { electronAPI?: unknown };
const saved = api.electronAPI;

type Props = Parameters<typeof useOfficeNarratives>[0];
const base: Props = {
	projectId: "p",
	tasks: [task("1", "in_progress", "coding")],
	ready: true,
	enabled: true,
	ai: false,
	language: "en",
};

describe("useOfficeNarratives", () => {
	beforeEach(() => {
		narrate.mockReset();
		api.electronAPI = { pixelOffice: { narrate } };
	});
	afterEach(() => {
		api.electronAPI = saved;
		vi.useRealTimers();
	});

	it("tells nothing on the first reading, then one scene per change", () => {
		const { result, rerender } = renderHook((props: Props) => useOfficeNarratives(props), {
			initialProps: base,
		});
		expect(result.current).toEqual([]);
		rerender({ ...base, tasks: [task("1", "in_progress", "qa_review")] });
		expect(result.current.map((s) => s.event.kind)).toEqual(["handed-to-qa"]);
		expect(result.current[0].text).toBeUndefined();
		expect(narrate).not.toHaveBeenCalled();
	});

	it("waits for the task list, and keeps the last few scenes", () => {
		const { result, rerender } = renderHook((props: Props) => useOfficeNarratives(props), {
			initialProps: { ...base, ready: false },
		});
		rerender({ ...base, ready: false, tasks: [task("1", "done")] });
		expect(result.current).toEqual([]);
		rerender(base);
		const many = ["2", "3", "4", "5"].map((id) => task(id, "human_review"));
		rerender({ ...base, tasks: [task("1", "in_progress", "coding"), ...many] });
		rerender({
			...base,
			tasks: [task("1", "in_progress", "coding"), ...many.map((t) => ({ ...t, status: "done" as const }))],
		});
		expect(result.current).toHaveLength(MAX_SCENES);
		expect(result.current.map((s) => s.event.taskId)).toEqual(["3", "4", "5"]);
	});

	it("lets a scene go after a while", () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook((props: Props) => useOfficeNarratives(props), {
			initialProps: base,
		});
		rerender({ ...base, tasks: [task("1", "error")] });
		expect(result.current).toHaveLength(1);
		act(() => vi.advanceTimersByTime(SCENE_TTL_MS));
		expect(result.current).toEqual([]);
	});

	it("forgets the scenes of a project it left, and its last reading", () => {
		const { result, rerender } = renderHook((props: Props) => useOfficeNarratives(props), {
			initialProps: base,
		});
		rerender({ ...base, tasks: [task("1", "error")] });
		expect(result.current).toHaveLength(1);
		rerender({ ...base, projectId: "q", tasks: [task("1", "done")] });
		expect(result.current).toEqual([]);
	});

	it("shows nothing while scenes are off, and does not replay them when on", () => {
		const { result, rerender } = renderHook((props: Props) => useOfficeNarratives(props), {
			initialProps: { ...base, enabled: false },
		});
		rerender({ ...base, enabled: false, tasks: [task("1", "error")] });
		expect(result.current).toEqual([]);
		rerender({ ...base, tasks: [task("1", "error")] });
		expect(result.current).toEqual([]);
	});

	it("puts the model's sentence in place of the template, and keeps it on failure", async () => {
		narrate
			.mockResolvedValueOnce({ success: true, text: "Coder hands it over." })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("ipc"));
		const { result, rerender } = renderHook((props: Props) => useOfficeNarratives(props), {
			initialProps: { ...base, ai: true, language: "fr" },
		});
		rerender({
			...base,
			ai: true,
			language: "fr",
			tasks: [
				task("1", "in_progress", "qa_review"),
				task("2", "done"),
				task("3", "done"),
			],
		});
		// Tasks 2 and 3 were not seen before: only task 1 changed hands.
		expect(narrate).toHaveBeenCalledTimes(1);
		expect(narrate.mock.calls[0][0]).toMatchObject({ kind: "handed-to-qa", language: "fr" });
		expect(narrate.mock.calls[0][0]).not.toHaveProperty("title");
		await waitFor(() => expect(result.current[0].text).toBe("Coder hands it over."));

		rerender({
			...base,
			ai: true,
			tasks: [task("1", "error"), task("2", "error"), task("3", "done")],
		});
		await waitFor(() => expect(narrate).toHaveBeenCalledTimes(3));
		await act(() => Promise.resolve());
		expect(result.current.slice(1).map((s) => s.text)).toEqual([undefined, undefined]);
	});

	it("keeps the template when the bridge is missing", () => {
		api.electronAPI = {};
		const { result, rerender } = renderHook((props: Props) => useOfficeNarratives(props), {
			initialProps: { ...base, ai: true },
		});
		rerender({ ...base, ai: true, tasks: [task("1", "error")] });
		expect(result.current).toHaveLength(1);
	});
});
