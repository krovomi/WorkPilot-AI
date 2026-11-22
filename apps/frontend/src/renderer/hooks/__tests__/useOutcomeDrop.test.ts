/**
 * @vitest-environment jsdom
 */
/**
 * Drops on and out of the outcome columns: « Échec » refuses them,
 * « Abandonnée » asks why, a card dragged out of « Abandonnée » is resumed.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { useAbandonRequestStore } from "../../stores/abandon-request-store";
import { resumeAbandonedTask, useTaskStore } from "../../stores/task-store";
import { toast } from "../use-toast";
import { dropColumnOf, useOutcomeDrop } from "../useOutcomeDrop";

vi.mock("../use-toast", () => ({ toast: vi.fn() }));
vi.mock("../../stores/task-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../stores/task-store")>()),
	resumeAbandonedTask: vi.fn(),
}));

const task = (id: string, overrides: Partial<Task> = {}) =>
	({ id, title: id, status: "backlog", ...overrides }) as Task;

const aside = task("aside", { status: "queue", metadata: { abandoned: true } as Task["metadata"] });
const broken = task("broken", { status: "error" });
const shipped = task("shipped", { status: "done" });

beforeEach(() => {
	vi.mocked(toast).mockClear();
	vi.mocked(resumeAbandonedTask).mockReset().mockResolvedValue({ success: true });
	useAbandonRequestStore.getState().close();
	useTaskStore.setState({ tasks: [task("a"), aside, broken, shipped] });
});

async function drop(selection: readonly Task[], dragged: Task, overId: string) {
	const { result } = renderHook(() => useOutcomeDrop(selection));
	let handled = false;
	await act(async () => {
		handled = await result.current(dragged, overId);
	});
	return handled;
}

describe("dropColumnOf", () => {
	it("reads a column id, or the column of the task under the drop", () => {
		const tasks = useTaskStore.getState().tasks;
		expect(dropColumnOf("done", tasks)).toBe("done");
		expect(dropColumnOf("broken", tasks)).toBe("failed");
		expect(dropColumnOf("aside", tasks)).toBe("abandoned");
		expect(dropColumnOf("nowhere", tasks)).toBeNull();
	});
});

describe("useOutcomeDrop", () => {
	it("leaves a drop in the card's own column, or on nothing, to the board", async () => {
		expect(await drop([], task("a"), "backlog")).toBe(false);
		expect(await drop([], task("a"), "nowhere")).toBe(false);
	});

	it("refuses a drop on Failed", async () => {
		expect(await drop([], task("a"), "failed")).toBe(true);
		expect(toast).toHaveBeenCalledWith({
			title: expect.stringMatching(/./),
		});
	});

	it("asks why for the dragged card dropped on Abandoned", async () => {
		expect(await drop([], task("a"), "aside")).toBe(true);
		expect(useAbandonRequestStore.getState().ids).toEqual(["a"]);
	});

	it("asks why for the whole selection, done cards left out", async () => {
		const selection = [task("a"), task("b"), shipped];
		expect(await drop(selection, task("a"), "abandoned")).toBe(true);
		expect(useAbandonRequestStore.getState().ids).toEqual(["a", "b"]);
	});

	it("says a done card cannot be abandoned", async () => {
		expect(await drop([], shipped, "abandoned")).toBe(true);
		expect(useAbandonRequestStore.getState().ids).toEqual([]);
		expect(toast).toHaveBeenCalledTimes(1);
	});

	it("resumes a card dragged out of Abandoned into its own column", async () => {
		expect(await drop([], aside, "queue")).toBe(true);
		expect(resumeAbandonedTask).toHaveBeenCalledWith("aside");
	});

	it("resumes it, then lets the board move it elsewhere", async () => {
		expect(await drop([], aside, "in_progress")).toBe(false);
		expect(resumeAbandonedTask).toHaveBeenCalledWith("aside");
	});

	it("stops and says so when the resume is refused", async () => {
		vi.mocked(resumeAbandonedTask).mockResolvedValueOnce({ success: false, error: "busy" });
		expect(await drop([], aside, "in_progress")).toBe(true);
		expect(toast).toHaveBeenCalledWith(
			expect.objectContaining({ description: "busy", variant: "destructive" }),
		);
		vi.mocked(resumeAbandonedTask).mockResolvedValueOnce({ success: false });
		expect(await drop([], aside, "in_progress")).toBe(true);
		expect(toast).toHaveBeenLastCalledWith(
			expect.objectContaining({ description: expect.stringMatching(/./) }),
		);
	});

	it("leaves a selection and a live card to the board", async () => {
		expect(await drop([aside, task("a")], aside, "in_progress")).toBe(false);
		expect(await drop([], task("a"), "in_progress")).toBe(false);
		expect(resumeAbandonedTask).not.toHaveBeenCalled();
	});
});
