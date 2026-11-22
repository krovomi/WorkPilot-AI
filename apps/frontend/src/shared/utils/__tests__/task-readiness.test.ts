import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import { isFirstStart, isShortCard, SHORT_CARD_CHARS } from "../task-readiness";

const card = (title: string, description: string, subtasks = 0) =>
	({ title, description, subtasks: Array.from({ length: subtasks }, () => ({})) }) as Task;

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
