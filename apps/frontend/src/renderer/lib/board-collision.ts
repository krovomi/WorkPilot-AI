import { type CollisionDetection, closestCorners, pointerWithin } from "@dnd-kit/core";

/**
 * Where a card dragged on the board lands: what the pointer is over, and the
 * closest corners only when the pointer is over nothing (a keyboard drag has
 * no pointer). With the closest corners alone, a card dropped in the middle
 * of a tall empty column went back to its own column whenever cards stood
 * beside it there: the four corners of a tall column are far from any card.
 */
export const boardCollision: CollisionDetection = (args) => {
	const under = pointerWithin(args);
	return under.length > 0 ? under : closestCorners(args);
};
