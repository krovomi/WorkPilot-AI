import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveCardFocus } from "../card-focus";

/** Columns of cards as the board renders them: a handle around each card. */
function board(columns: Record<string, string[]>) {
	document.body.innerHTML = Object.entries(columns)
		.map(
			([status, titles]) =>
				`<div data-column-status="${status}">${titles
					.map(
						(title) =>
							`<div data-task-id="${title}" tabindex="0"><div class="kanban-card" tabindex="0" aria-label="${title}"><button>menu</button></div></div>`,
					)
					.join("")}</div>`,
		)
		.join("");
}

const card = (title: string) =>
	document.querySelector(`[aria-label="${title}"]`) as HTMLElement;
const handle = (title: string) =>
	document.querySelector(`[data-task-id="${title}"]`) as HTMLElement;

beforeEach(() =>
	board({ backlog: ["a1", "a2", "a3"], queue: [], in_progress: ["c1"], done: ["d1", "d2"] }),
);
afterEach(() => {
	document.body.innerHTML = "";
});

describe("moveCardFocus", () => {
	it("moves up and down within a column, and stops at its ends", () => {
		expect(moveCardFocus(card("a1"), "down")).toEqual({
			title: "a2",
			position: 2,
			count: 3,
			status: "backlog",
		});
		expect(document.activeElement).toBe(card("a2"));
		expect(moveCardFocus(card("a2"), "up")?.title).toBe("a1");
		expect(moveCardFocus(card("a1"), "up")).toBeNull();
		expect(moveCardFocus(card("a3"), "down")).toBeNull();
	});

	it("moves sideways to the next column with cards, at the same row or its last", () => {
		expect(moveCardFocus(card("a3"), "right")).toEqual({
			title: "c1",
			position: 1,
			count: 1,
			status: "in_progress",
		});
		expect(moveCardFocus(card("c1"), "left")?.title).toBe("a1");
		expect(moveCardFocus(card("c1"), "right")?.title).toBe("d1");
		expect(moveCardFocus(card("d2"), "left")?.title).toBe("c1");
		expect(moveCardFocus(card("d1"), "right")).toBeNull();
		expect(moveCardFocus(card("a1"), "left")).toBeNull();
	});

	it("goes from a drag handle to the next card", () => {
		expect(moveCardFocus(handle("a1"), "down")?.title).toBe("a2");
		expect(document.activeElement).toBe(card("a2"));
	});

	it("leaves keys from a card's controls, from outside cards and during a keyboard drag", () => {
		expect(moveCardFocus(card("a1").querySelector("button"), "down")).toBeNull();
		expect(moveCardFocus(document.body, "down")).toBeNull();
		expect(moveCardFocus(null, "down")).toBeNull();
		handle("c1").setAttribute("aria-pressed", "true");
		expect(moveCardFocus(card("a1"), "down")).toBeNull();
	});
});
