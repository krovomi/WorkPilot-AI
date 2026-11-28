import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import { cardBody, isFirstStart, isShortCard, SHORT_CARD_CHARS } from "../task-readiness";

const card = (title: string, description: string, subtasks = 0) =>
	({ title, description, subtasks: Array.from({ length: subtasks }, () => ({})) }) as Task;

describe("cardBody", () => {
	it("keeps what the card says besides a title it may repeat", () => {
		expect(cardBody(card("Fix login", " Fix login "))).toBe("");
		expect(cardBody({ title: "Fix login" } as Task)).toBe("");
		expect(cardBody(card("Fix login", " The admin page only "))).toBe("The admin page only");
	});

	it("reads rich text without its tags", () => {
		expect(cardBody(card("Fix login", "<p>Fix login</p>"))).toBe("");
		expect(cardBody(card("Fix login", "<p>Only&nbsp;the  <b>admin</b></p><ul><li>page</li></ul><br>"))).toBe(
			"Only the admin\npage",
		);
	});

	it("does not take a long rich-text card for a short one, nor markup for words", () => {
		expect(isShortCard(card("Fix login", `<p>${"<b>x</b>".repeat(40)}</p>`))).toBe(true);
		expect(isShortCard(card("Fix login", `<p>${"x".repeat(SHORT_CARD_CHARS)}</p>`))).toBe(false);
	});
});

describe("isShortCard", () => {
	it("calls a card with only a title, or a short description, short", () => {
		expect(isShortCard(card("Fix login", ""))).toBe(true);
		expect(isShortCard(card("Fix login", "  Fix login "))).toBe(true);
		expect(isShortCard(card("Fix login", "x".repeat(SHORT_CARD_CHARS - 1)))).toBe(true);
		expect(isShortCard({ title: "Fix login", subtasks: [] } as unknown as Task)).toBe(true);
	});

	it("does not call a described or planned card short", () => {
		expect(isShortCard(card("Fix login", "x".repeat(SHORT_CARD_CHARS)))).toBe(false);
		expect(isShortCard(card("Fix login", "", 2))).toBe(false);
	});
});

describe("isFirstStart", () => {
	it("is a first start from Planning or the queue only", () => {
		expect(isFirstStart({ status: "backlog" })).toBe(true);
		expect(isFirstStart({ status: "queue" })).toBe(true);
		expect(isFirstStart({ status: "human_review" })).toBe(false);
	});
});
