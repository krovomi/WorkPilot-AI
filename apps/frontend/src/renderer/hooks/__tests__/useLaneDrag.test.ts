/**
 * @vitest-environment jsdom
 */
/**
 * Moves across lanes: the field of the target lane is written before the
 * board moves the card, a lane the board does not own refuses the drop,
 * and the pinned « Bloquées » lane flags and lifts.
 */
import type { DragEndEvent, DragOverEvent } from "@dnd-kit/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { applyCardChoice } from "../../lib/card-edits";
import { FLAGGED_LANE, laneDropId, NO_VALUE_LANE } from "../../lib/kanban-lanes";
import { useFlagRequestStore } from "../../stores/flag-request-store";
import { DEFAULT_LANE_PREFERENCES, useKanbanLanesStore } from "../../stores/kanban-lanes-store";
import { unflagTask } from "../../stores/task-flag-actions";
import { useSprintStore } from "../../stores/sprint-store";
import { useTaskStore } from "../../stores/task-store";
import { toast } from "../use-toast";
import { useLaneDrag, useLaneOverStore, withPlainColumn } from "../useLaneDrag";

vi.mock("../use-toast", () => ({ toast: vi.fn() }));
vi.mock("../../lib/card-edits", () => ({ applyCardChoice: vi.fn() }));
vi.mock("../../stores/task-flag-actions", () => ({ unflagTask: vi.fn() }));

const card = (id: string, metadata: Task["metadata"] = {}, status: Task["status"] = "backlog") =>
	({ id, specId: id, title: id, status, metadata }) as Task;

const high = card("high", { priority: "high" });
const low = card("low", { priority: "low" });
const blocked = card("blocked", { priority: "low", flagged: true });
const shipped = card("shipped", { priority: "low" }, "done");

const end = (active: string, over: string | null) =>
	({ active: { id: active }, over: over === null ? null : { id: over } }) as unknown as DragEndEvent;

function setup(selection: Task[] = []) {
	const onDragOver = vi.fn();
	const onDragEnd = vi.fn();
	const { result } = renderHook(() => useLaneDrag(onDragOver, onDragEnd, selection));
	return { onDragOver, onDragEnd, drag: result.current };
}

beforeEach(() => {
	vi.mocked(toast).mockClear();
	vi.mocked(applyCardChoice).mockReset().mockResolvedValue(0);
	vi.mocked(unflagTask).mockReset().mockResolvedValue({ success: true });
	useFlagRequestStore.getState().close();
	useLaneOverStore.setState({ lane: null });
	useTaskStore.setState({ tasks: [high, low, blocked, shipped] });
	useKanbanLanesStore.setState({ ...DEFAULT_LANE_PREFERENCES, grouping: "priority", projectId: "p" });
});

describe("withPlainColumn", () => {
	it("gives the board the column of a lane's drop target", () => {
		expect(withPlainColumn(end("low", laneDropId("high", "queue"))).over?.id).toBe("queue");
		expect(withPlainColumn(end("low", "high")).over?.id).toBe("high");
	});
});

describe("useLaneDrag", () => {
	it("lights the lane under the card and hands the board the plain column", () => {
		const { drag, onDragOver } = setup();
		act(() => drag.onDragOver(end("low", laneDropId("high", "queue")) as unknown as DragOverEvent));
		expect(useLaneOverStore.getState().lane).toBe("high");
		expect(onDragOver.mock.calls[0][0].over.id).toBe("queue");
		act(() => drag.onDragOver(end("low", "high") as unknown as DragOverEvent));
		expect(useLaneOverStore.getState().lane).toBe("high");
	});

	it("writes the target lane's priority, then lets the board move the card", async () => {
		const { drag, onDragEnd } = setup();
		await act(() => drag.onDragEnd(end("low", laneDropId("high", "queue"))));
		expect(applyCardChoice).toHaveBeenCalledWith([low], { priority: "high" }, "lane move");
		expect(onDragEnd.mock.calls[0][0].over.id).toBe("queue");
	});

	it("moves the whole selection, except the cards already in the lane", async () => {
		const { drag } = setup([low, high]);
		await act(() => drag.onDragEnd(end("low", laneDropId(NO_VALUE_LANE, "backlog"))));
		expect(applyCardChoice).toHaveBeenCalledWith([low, high], { priority: undefined }, "lane move");
		vi.mocked(applyCardChoice).mockClear();
		await act(() => drag.onDragEnd(end("low", laneDropId("high", "backlog"))));
		expect(applyCardChoice).toHaveBeenCalledWith([low], { priority: "high" }, "lane move");
	});

	it("only moves the card within its lane", async () => {
		const { drag, onDragEnd } = setup();
		await act(() => drag.onDragEnd(end("low", laneDropId("low", "done"))));
		expect(applyCardChoice).not.toHaveBeenCalled();
		expect(onDragEnd.mock.calls[0][0].over.id).toBe("done");
	});

	it("refuses a lane whose field the board does not write", async () => {
		useKanbanLanesStore.setState({ grouping: "source" });
		useTaskStore.setState({ tasks: [card("jira", { importSource: "jira" }), low] });
		const { drag, onDragEnd } = setup();
		await act(() => drag.onDragEnd(end("low", laneDropId("jira", "backlog"))));
		expect(applyCardChoice).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalledWith({ title: expect.stringContaining("Origin") });
		// The board ends the drag as a cancelled one.
		expect(onDragEnd.mock.calls[0][0].over).toBeNull();
	});

	it("asks why when cards are dropped in « Bloquées », leaving done ones out", async () => {
		const { drag } = setup([low, shipped]);
		await act(() => drag.onDragEnd(end("low", laneDropId(FLAGGED_LANE, "backlog"))));
		expect(useFlagRequestStore.getState().ids).toEqual(["low"]);
		expect(applyCardChoice).not.toHaveBeenCalled();
	});

	it("lifts the flag of a card dragged out of « Bloquées », and writes the new lane", async () => {
		const { drag } = setup();
		await act(() => drag.onDragEnd(end("blocked", laneDropId("low", "backlog"))));
		expect(unflagTask).toHaveBeenCalledWith("blocked");
		expect(applyCardChoice).not.toHaveBeenCalled();
		await act(() => drag.onDragEnd(end("blocked", laneDropId("high", "backlog"))));
		expect(applyCardChoice).toHaveBeenCalledWith([blocked], { priority: "high" }, "lane move");
	});

	it("says when a card could not be saved in its new lane", async () => {
		vi.mocked(applyCardChoice).mockResolvedValue(1);
		const { drag } = setup();
		await act(() => drag.onDragEnd(end("low", laneDropId("high", "backlog"))));
		expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" }));
	});

	it("does nothing of its own without lanes", async () => {
		useKanbanLanesStore.setState({ grouping: "none" });
		const { drag, onDragEnd, onDragOver } = setup();
		act(() => drag.onDragOver(end("low", "queue") as unknown as DragOverEvent));
		await act(() => drag.onDragEnd(end("low", "queue")));
		expect(useLaneOverStore.getState().lane).toBeNull();
		expect(onDragOver).toHaveBeenCalledTimes(1);
		expect(onDragEnd.mock.calls[0][0].over.id).toBe("queue");
		expect(applyCardChoice).not.toHaveBeenCalled();
	});

	it("puts a card in an open sprint's lane, and refuses a closed sprint", async () => {
		useKanbanLanesStore.setState({ grouping: "sprint" });
		useSprintStore.setState({
			sprints: [
				{ id: "sp-0000000a", name: "A", state: "active", createdAt: "t" },
				{ id: "sp-0000000c", name: "C", state: "closed", createdAt: "t" },
			],
		});
		const { drag } = setup();
		await act(() => drag.onDragEnd(end("low", laneDropId("sp-0000000a", "backlog"))));
		expect(applyCardChoice).toHaveBeenCalledWith([low], { sprintId: "sp-0000000a" }, "lane move");
		vi.mocked(applyCardChoice).mockClear();
		await act(() => drag.onDragEnd(end("low", laneDropId("sp-0000000c", "backlog"))));
		expect(applyCardChoice).not.toHaveBeenCalled();
		expect(toast).toHaveBeenCalled();
	});
});
