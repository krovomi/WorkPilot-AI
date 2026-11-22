import { createContext } from "react";
import type { CardType } from "../../../shared/constants/card-types";
import type { TaskPriority } from "../../../shared/types";

/**
 * The board's selection, for a card's right-click menu: on a card that is
 * part of a selection of several, the menu acts on the whole selection.
 */
export interface BoardSelection {
	selectedTaskIds: ReadonlySet<string>;
	onSetType: (type: CardType) => void;
	onSetPriority: (priority: TaskPriority) => void;
	onDelete: () => void;
	onClear: () => void;
}

export const BoardSelectionContext = createContext<BoardSelection | null>(null);
