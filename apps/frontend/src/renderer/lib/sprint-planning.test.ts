import { describe, expect, it } from "vitest";
import type { Sprint, Task } from "../../shared/types";
import { NO_SPRINT } from "./kanban-filter";
import {
	byPlanningOrder,
	carriedFromSprint,
	daysLeft,
	focusedSprint,
	isPlannable,
	matchesQuick,
	matchesSearch,
	missingBlockers,
	planningPools,
	waitingOn,
} from "./sprint-planning";

const sprint = (id: string, state: Sprint["state"], endDate?: string): Sprint => ({
	id,
	name: id,
	state,
	createdAt: "t",
	endDate,
});

const card = (id: string, extra: Partial<Task> & { metadata?: Task["metadata"] } = {}) =>
	({ id, specId: `00${id}`, title: id, status: "backlog", createdAt: "2026-11-01T10:00:00Z", ...extra }) as unknown as Task;

describe("focusedSprint", () => {
	const sprints = [sprint("sp-0000000a", "active"), sprint("sp-0000000b", "planned")];

	it("is the filtered sprint, else the active one", () => {
		expect(focusedSprint(sprints, "sp-0000000b")?.id).toBe("sp-0000000b");
		expect(focusedSprint(sprints, undefined)?.id).toBe("sp-0000000a");
	});

	it("is none on the backlog, without an active sprint, or for a sprint that is gone", () => {
		expect(focusedSprint(sprints, NO_SPRINT)).toBeUndefined();
		expect(focusedSprint([sprint("sp-0000000b", "planned")], undefined)).toBeUndefined();
		expect(focusedSprint(sprints, "sp-000000ff")).toBeUndefined();
	});
});

describe("planningPools", () => {
	it("puts open cards without a sprint in the backlog and the sprint's cards, finished ones too, on its side", () => {
		const tasks = [
			card("open"),
			card("done", { status: "done" }),
			card("gone", { metadata: { abandoned: true } }),
			card("archived", { metadata: { archivedAt: "2026-11-02" } }),
			card("other", { metadata: { sprintId: "sp-0000000b" } }),
			card("mine", { metadata: { sprintId: "sp-0000000a", smartEstimate: { complexityScore: 5 } } as Task["metadata"] }),
			card("mineDone", {
				status: "done",
				metadata: { sprintId: "sp-0000000a", smartEstimate: { complexityScore: 3 } } as Task["metadata"],
			}),
		];
		const pools = planningPools(tasks, "sp-0000000a");
		expect(pools.backlog.map((task) => task.id)).toEqual(["open"]);
		expect(pools.sprint.map((task) => task.id).sort()).toEqual(["mine", "mineDone"]);
		expect(pools.points).toBe(8);
	});

	it("orders the backlog by priority, then the oldest card first", () => {
		const tasks = [
			card("lowOld", { metadata: { priority: "low" }, createdAt: "2026-10-01T00:00:00Z" as unknown as Date }),
			card("none", { createdAt: "2026-09-01T00:00:00Z" as unknown as Date }),
			card("urgentNew", { metadata: { priority: "urgent" }, createdAt: "2026-11-20T00:00:00Z" as unknown as Date }),
			card("urgentOld", { metadata: { priority: "urgent" }, createdAt: "2026-11-10T00:00:00Z" as unknown as Date }),
		];
		expect([...tasks].sort(byPlanningOrder).map((task) => task.id)).toEqual(["urgentOld", "urgentNew", "lowOld", "none"]);
	});
});

describe("isPlannable", () => {
	it("refuses finished, abandoned and archived cards", () => {
		expect(isPlannable(card("a"))).toBe(true);
		expect(isPlannable(card("b", { status: "done" }))).toBe(false);
		expect(isPlannable(card("c", { metadata: { abandoned: true } }))).toBe(false);
		expect(isPlannable(card("d", { metadata: { archivedAt: "x" } }))).toBe(false);
	});
});

describe("matchesSearch", () => {
	it("finds a card by its title or spec id, ignoring case and accents", () => {
		const task = card("Créer le panier");
		expect(matchesSearch(task, "  creer LE pan ")).toBe(true);
		expect(matchesSearch(task, "00Créer")).toBe(true);
		expect(matchesSearch(task, "paiement")).toBe(false);
		expect(matchesSearch(task, "")).toBe(true);
	});
});

describe("daysLeft", () => {
	const noon = (day: string) => new Date(`${day}T12:00:00`).getTime();

	it("counts calendar days to the last day: 0 on it, negative after", () => {
		expect(daysLeft({ endDate: "2026-12-02" }, noon("2026-11-28"))).toBe(4);
		expect(daysLeft({ endDate: "2026-11-28" }, noon("2026-11-28"))).toBe(0);
		expect(daysLeft({ endDate: "2026-11-26" }, noon("2026-11-28"))).toBe(-2);
	});

	it("is unknown without an end day", () => {
		expect(daysLeft({}, noon("2026-11-28"))).toBeNull();
	});
});

describe("planning helps", () => {
	const SP = "sp-0000000a";

	it("filters the backlog by urgency, bugs and missing estimates", () => {
		const urgent = card("u", { metadata: { priority: "urgent", smartEstimate: { complexityScore: 3 } } as Task["metadata"] });
		const high = card("h", { metadata: { priority: "high" } as Task["metadata"] });
		const bug = card("b", { metadata: { category: "bug_fix", smartEstimate: { complexityScore: 2 } } as Task["metadata"] });
		expect([urgent, high, bug].filter((task) => matchesQuick(task, "urgent")).map((task) => task.id)).toEqual(["u", "h"]);
		expect([urgent, high, bug].filter((task) => matchesQuick(task, "bugs")).map((task) => task.id)).toEqual(["b"]);
		expect([urgent, high, bug].filter((task) => matchesQuick(task, "unestimated")).map((task) => task.id)).toEqual(["h"]);
		expect([urgent, high, bug].every((task) => matchesQuick(task, "all"))).toBe(true);
	});

	it("names the closed sprint that carried a card only while the card is where it carried it", () => {
		const closed: Sprint = {
			...sprint("sp-0000000c", "closed"),
			report: { done: 0, donePoints: 0, carried: 1, carriedPoints: 0, carriedTo: SP },
		};
		const carried = card("c", { metadata: { sprintId: SP, carriedFrom: closed.id } as Task["metadata"] });
		expect(carriedFromSprint(carried, [closed])?.id).toBe(closed.id);
		// Moved by a person to another sprint since: no longer « carried over ».
		const moved = card("m", { metadata: { sprintId: "sp-0000000b", carriedFrom: closed.id } as Task["metadata"] });
		expect(carriedFromSprint(moved, [closed])).toBeUndefined();
		expect(carriedFromSprint(card("n"), [closed])).toBeUndefined();
	});

	it("lists what a card waits on outside its sprint, and what of it is still in the backlog", () => {
		const blocker = card("a");
		const inSprint = card("s", { metadata: { sprintId: SP } as Task["metadata"] });
		const done = card("d", { status: "done" });
		const elsewhere = card("e", { metadata: { sprintId: "sp-0000000b" } as Task["metadata"] });
		const waiting = card("w", {
			metadata: { sprintId: SP, blockedBy: ["00a", "s", "d", "e", "gone", "w"] } as Task["metadata"],
		});
		const all = [blocker, inSprint, done, elsewhere, waiting];
		expect(waitingOn(waiting, all).map((task) => task.id)).toEqual(["a", "e"]);
		// Only the backlog card can be added: « e » is planned in another sprint.
		expect(missingBlockers([waiting, inSprint], all).map((task) => task.id)).toEqual(["a"]);
		expect(missingBlockers([{ ...waiting, status: "done" } as Task], all)).toEqual([]);
	});
});
