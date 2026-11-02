import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTaskPanelStore } from "../../stores/task-panel-store";
import { type PanelCardId, panelCardDomId } from "./panel-sections";

interface PanelCardSlotProps {
	readonly taskId: string;
	readonly card: PanelCardId;
	readonly onPresence: (card: PanelCardId, has: boolean) => void;
	readonly children: ReactNode;
}

/**
 * The place of one card in a tab of the task panel.
 *
 * A card says it has nothing to show by rendering nothing — that is the rule
 * every card of the panel already follows, each with its own reasons (no PR,
 * no capture, hermes not installed…). The slot observes it rather than
 * repeating those reasons: an empty slot is `hidden`, and its tab learns it
 * through `onPresence`, so a tab whose cards are all silent can say so.
 *
 * The slot is also the target of the "waiting for you" banner: when the
 * banner asks for this card (`task-panel-store.pendingReveal`), the slot
 * scrolls to it and takes the focus once the card is there.
 */
export function PanelCardSlot({ taskId, card, onPresence, children }: PanelCardSlotProps) {
	const node = useRef<HTMLDivElement>(null);
	// Hidden until measured: the layout effect answers before the first paint.
	const [has, setHas] = useState(false);
	const wanted = useTaskPanelStore(
		(s) => s.pendingReveal?.taskId === taskId && s.pendingReveal.card === card,
	);

	useLayoutEffect(() => {
		const el = node.current;
		if (!el) return;
		const update = () => {
			const next = el.childElementCount > 0;
			setHas(next);
			onPresence(card, next);
		};
		update();
		const observer = new MutationObserver(update);
		observer.observe(el, { childList: true });
		return () => {
			observer.disconnect();
			onPresence(card, false);
		};
	}, [card, onPresence]);

	useEffect(() => {
		const el = node.current;
		if (!wanted || !has || !el) return;
		el.scrollIntoView?.({ behavior: "smooth", block: "start" });
		el.focus({ preventScroll: true });
		useTaskPanelStore.getState().clearReveal();
	}, [wanted, has]);

	return (
		<div
			ref={node}
			id={panelCardDomId(taskId, card)}
			data-panel-card={card}
			hidden={!has}
			tabIndex={-1}
			className="scroll-mt-4 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{children}
		</div>
	);
}
