/**
 * The dialogs the board opens from a card's menu or a drop, mounted once
 * (KanbanBoard.tsx is at its size ceiling: one line mounts them all).
 */
import { AbandonRequestDialog } from "./AbandonRequestDialog";
import { FlagRequestDialog } from "./FlagRequestDialog";

export function BoardDialogs() {
	return (
		<>
			<AbandonRequestDialog />
			<FlagRequestDialog />
		</>
	);
}
