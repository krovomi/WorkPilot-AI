import { type ClientRect, closestCorners, type CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";
import { boardCollision } from "../board-collision";

type Args = Parameters<CollisionDetection>[0];

const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
	left,
	top,
	width,
	height,
	right: left + width,
	bottom: top + height,
});

// A tall board: Planning holds a card level with the drop, Queue is empty.
const RECTS: Record<string, ClientRect> = {
	backlog: rect(0, 0, 280, 900),
	"card-a": rect(10, 400, 260, 180),
	queue: rect(292, 0, 280, 900),
};

function args(pointer: { x: number; y: number } | null): Args {
	const droppableRects = new Map(Object.entries(RECTS));
	const droppableContainers = Object.keys(RECTS).map((id) => ({
		id,
		key: id,
		data: { current: {} },
		disabled: false,
		node: { current: null },
		rect: { current: RECTS[id] },
	}));
	return {
		active: { id: "card-b", data: { current: {} }, rect: { current: { initial: null, translated: null } } },
		// The dragged card, held over the middle of Queue.
		collisionRect: rect(300, 400, 260, 180),
		droppableRects,
		droppableContainers,
		pointerCoordinates: pointer,
	} as unknown as Args;
}

describe("boardCollision", () => {
	it("drops on the column under the pointer, where the closest corners pick the card beside it", () => {
		const over = args({ x: 430, y: 450 });
		expect(closestCorners(over)[0].id).toBe("card-a");
		expect(boardCollision(over)[0].id).toBe("queue");
	});

	it("prefers the card under the pointer to its column", () => {
		expect(boardCollision(args({ x: 100, y: 450 }))[0].id).toBe("card-a");
	});

	it("falls back on the closest corners without a pointer (a keyboard drag) or over nothing", () => {
		expect(boardCollision(args(null))).toEqual(closestCorners(args(null)));
		expect(boardCollision(args({ x: 2000, y: 2000 }))).toEqual(closestCorners(args({ x: 2000, y: 2000 })));
	});
});
