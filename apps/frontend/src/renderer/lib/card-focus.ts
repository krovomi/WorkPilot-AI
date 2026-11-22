/**
 * Arrow-key moves between the board's cards: up and down within a column,
 * left and right to the nearest column that shows cards, at the same row
 * or its last card. Design: docs/architecture/kanban-quick-edit.md.
 */
export type FocusDirection = "up" | "down" | "left" | "right";

export const ARROW_DIRECTIONS: Readonly<Record<string, FocusDirection>> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
};

/** Where the focus landed, for the screen reader announcement. */
export interface CardFocus {
	title: string;
	position: number;
	count: number;
	status: string;
}

const CARD = "[data-task-id]";
const COLUMN = "[data-column-status]";

const cardsOf = (column: Element) => Array.from(column.querySelectorAll<HTMLElement>(CARD));

/**
 * Moves the focus from a card (or its drag handle) to its neighbour and
 * says where it landed; null when the key is not for a card, when a card is
 * being moved by keyboard, or at the edge of the board.
 */
export function moveCardFocus(from: EventTarget | null, direction: FocusDirection): CardFocus | null {
	if (!(from instanceof HTMLElement)) return null;
	const card = from.closest<HTMLElement>(CARD);
	if (!card || (from !== card && !from.classList.contains("kanban-card"))) return null;
	// A card lifted with Space moves with the arrows itself (dnd-kit).
	if (document.querySelector(`${CARD}[aria-pressed="true"]`)) return null;
	const column = card.closest(COLUMN) as Element;
	const index = cardsOf(column).indexOf(card);
	let target = column;
	let next: number;
	if (direction === "up" || direction === "down") {
		next = index + (direction === "up" ? -1 : 1);
	} else {
		const columns = Array.from(document.querySelectorAll(COLUMN)).filter(
			(other) => other === column || cardsOf(other).length > 0,
		);
		const beside = columns[columns.indexOf(column) + (direction === "left" ? -1 : 1)];
		if (!beside) return null;
		target = beside;
		next = Math.min(index, cardsOf(beside).length - 1);
	}
	const cards = cardsOf(target);
	const landing = cards[next]?.querySelector<HTMLElement>(".kanban-card");
	if (!landing) return null;
	landing.focus();
	return {
		title: landing.getAttribute("aria-label") as string,
		position: next + 1,
		count: cards.length,
		status: target.getAttribute("data-column-status") as string,
	};
}
