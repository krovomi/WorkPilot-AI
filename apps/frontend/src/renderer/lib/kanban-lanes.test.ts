/**
 * Swimlanes: which lane a card sits in, the lanes a board shows and in which
 * order, what a move to another lane writes, and the lanes' drop targets.
 */
import { describe, expect, it } from "vitest";
import type { TaskStatusColumn } from "../../shared/constants/task";
import type { Task } from "../../shared/types";
import {
	buildLanes,
	cleanArea,
	FLAGGED_LANE,
	isEditableGrouping,
	laneDropId,
	laneKeyOf,
	laneMetadata,
	NO_VALUE_LANE,
	parseLaneDropId,
} from "./kanban-lanes";

const card = (id: string, metadata: Task["metadata"] = {}, specId = id) =>
	({ id, specId, title: id, status: "backlog", metadata }) as Task;

const urgent = card("urgent", { priority: "urgent" });
const low = card("low", { priority: "low" });
const plain = card("plain");
const blocked = card("blocked", { priority: "low", flagged: true });

describe("laneKeyOf", () => {
	it("reads the grouping's field, or the no-value lane", () => {
		expect(laneKeyOf(urgent, { grouping: "priority", pinFlagged: false })).toBe("urgent");
		expect(laneKeyOf(plain, { grouping: "priority", pinFlagged: false })).toBe(NO_VALUE_LANE);
		expect(laneKeyOf(card("a", { area: "  apps/web " }), { grouping: "area", pinFlagged: false })).toBe("apps/web");
		expect(laneKeyOf(card("j", { importSource: "jira" }), { grouping: "source", pinFlagged: false })).toBe("jira");
		expect(laneKeyOf(card("b", { category: "bug_fix" }), { grouping: "type", pinFlagged: false })).toBe("bug");
		const part = card("p", { splitGroup: { parent: "001-big" } } as Task["metadata"]);
		expect(laneKeyOf(part, { grouping: "parent", pinFlagged: false })).toBe("001-big");
	});

	it("puts a flagged card in the pinned lane only when it is pinned", () => {
		expect(laneKeyOf(blocked, { grouping: "priority", pinFlagged: true })).toBe(FLAGGED_LANE);
		expect(laneKeyOf(blocked, { grouping: "priority", pinFlagged: false })).toBe("low");
	});
});

describe("buildLanes", () => {
	const columns = (backlog: Task[], done: Task[] = []): Partial<Record<TaskStatusColumn, Task[]>> => ({
		backlog,
		done,
	});

	it("has no lanes without a grouping", () => {
		expect(buildLanes(columns([urgent]), { grouping: "none", pinFlagged: true })).toEqual([]);
	});

	it("orders the flagged lane, the values, then the cards without a value", () => {
		const lanes = buildLanes(columns([low, plain, blocked], [urgent]), { grouping: "priority", pinFlagged: true });
		expect(lanes.map((lane) => lane.key)).toEqual([FLAGGED_LANE, "urgent", "high", "medium", "low", NO_VALUE_LANE]);
		const byKey = Object.fromEntries(lanes.map((lane) => [lane.key, lane]));
		expect(byKey[FLAGGED_LANE].columns.backlog).toEqual([blocked]);
		expect(byKey.urgent.columns.done).toEqual([urgent]);
		expect(byKey.low.count).toBe(1);
		// Empty priorities stay: they are where a card is moved to.
		expect(byKey.high.count).toBe(0);
	});

	it("shows only the values the cards have for a field the board does not write", () => {
		const lanes = buildLanes(columns([card("j", { importSource: "jira" }), plain]), {
			grouping: "source",
			pinFlagged: false,
		});
		expect(lanes.map((lane) => lane.key)).toEqual(["jira", "manual"]);
	});

	it("adds the known sub-projects, sorted, and keeps a column's order", () => {
		const web1 = card("w1", { area: "web" });
		const web2 = card("w2", { area: "web" });
		const lanes = buildLanes(columns([web2, web1]), {
			grouping: "area",
			pinFlagged: false,
			knownAreas: ["mobile", "api", "bad\nname"],
		});
		expect(lanes.map((lane) => lane.key)).toEqual(["api", "mobile", "web", NO_VALUE_LANE]);
		expect(lanes[2].columns.backlog).toEqual([web2, web1]);
		expect(lanes[2].value).toBe("web");
		expect(lanes[3].value).toBeUndefined();
	});
});

describe("laneMetadata", () => {
	it("writes the lane's priority, or clears it in the no-priority lane", () => {
		expect(laneMetadata("priority", "high")).toEqual({ priority: "high" });
		expect(laneMetadata("priority", NO_VALUE_LANE)).toEqual({ priority: undefined });
		expect(laneMetadata("priority", "whenever")).toBeNull();
	});

	it("chooses a type, never clears one", () => {
		expect(laneMetadata("type", "bug")).toEqual({ kind: "bug_fix", kindSource: "user" });
		expect(laneMetadata("type", NO_VALUE_LANE)).toBeNull();
		expect(laneMetadata("type", "not-a-type")).toBeNull();
	});

	it("writes or clears the sub-project, refusing a name that is not one", () => {
		expect(laneMetadata("area", "apps/web")).toEqual({ area: "apps/web" });
		expect(laneMetadata("area", NO_VALUE_LANE)).toEqual({ area: undefined });
		expect(laneMetadata("area", "x".repeat(81))).toBeNull();
	});

	it("leaves the flagged lane and the fields the board does not own alone", () => {
		expect(laneMetadata("priority", FLAGGED_LANE)).toBeNull();
		expect(laneMetadata("source", "jira")).toBeNull();
		expect(laneMetadata("parent", "001-big")).toBeNull();
		expect(isEditableGrouping("source")).toBe(false);
		expect(isEditableGrouping("area")).toBe(true);
	});
});

describe("cleanArea", () => {
	it("keeps one trimmed line of 80 characters at most", () => {
		expect(cleanArea("  api ")).toBe("api");
		expect(cleanArea("")).toBeNull();
		expect(cleanArea("a\tb")).toBeNull();
		expect(cleanArea(42)).toBeNull();
		expect(cleanArea("x".repeat(80))).toHaveLength(80);
	});
});

describe("lane drop ids", () => {
	it("round-trips a lane and a column, and ignores other ids", () => {
		const id = laneDropId("apps::web", "in_progress");
		expect(parseLaneDropId(id)).toEqual({ lane: "apps::web", column: "in_progress" });
		expect(parseLaneDropId("in_progress")).toBeNull();
		expect(parseLaneDropId("lane::backlog::")).toBeNull();
		expect(parseLaneDropId("lane::::x")).toBeNull();
	});
});

describe("sprint lanes", () => {
	const sprints = [
		{ id: "sp-0000000a", state: "active" },
		{ id: "sp-0000000b", state: "planned" },
		{ id: "sp-0000000c", state: "closed" },
	];

	it("shows the open sprints even empty, in reading order, then the backlog", () => {
		const done = card("old", { sprintId: "sp-0000000c" });
		const lanes = buildLanes({ backlog: [plain, done] }, { grouping: "sprint", pinFlagged: false, knownSprints: sprints });
		expect(lanes.map((lane) => lane.key)).toEqual(["sp-0000000a", "sp-0000000b", "sp-0000000c", NO_VALUE_LANE]);
		expect(laneKeyOf(card("x", { sprintId: "../x" }), { grouping: "sprint", pinFlagged: false })).toBe(NO_VALUE_LANE);
	});

	it("moves a card into an open sprint or the backlog, never into a closed or unknown one", () => {
		const open = ["sp-0000000a", "sp-0000000b"];
		expect(isEditableGrouping("sprint")).toBe(true);
		expect(laneMetadata("sprint", "sp-0000000b", open)).toEqual({ sprintId: "sp-0000000b" });
		expect(laneMetadata("sprint", NO_VALUE_LANE, open)).toEqual({ sprintId: undefined });
		expect(laneMetadata("sprint", "sp-0000000c", open)).toBeNull();
		expect(laneMetadata("sprint", "not-a-sprint", ["not-a-sprint"])).toBeNull();
	});
});
