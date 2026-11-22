import {
	type ReactNode,
	type RefObject,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export interface MenuPoint {
	x: number;
	y: number;
}

/**
 * Where a right-click menu opens: at the pointer, or near the top-left
 * corner of the element when the menu key or Shift+F10 opened it (the event
 * then has no pointer position).
 */
export function contextMenuPoint(
	event: { clientX: number; clientY: number },
	element: Element | null,
): MenuPoint {
	if (event.clientX !== 0 || event.clientY !== 0 || !element) {
		return { x: event.clientX, y: event.clientY };
	}
	const rect = element.getBoundingClientRect();
	return { x: rect.left + 8, y: rect.top + 24 };
}

/**
 * True for an event that bubbled up the React tree from a portal (a menu or
 * a dialog) rather than from inside the element itself: a card or a column
 * neither opens, nor starts a drag, nor shows its own menu on those.
 */
export function isFromPortal(e: SyntheticEvent): boolean {
	return !(e.currentTarget as Node).contains(e.target as Node);
}

/**
 * The point where a right-click on the element asked for its menu, or null.
 * A right-click on something matching `ignore` (a card, a text field) keeps
 * its own menu. A native listener: a portal's right-click never reaches it.
 */
export function useContextMenuAt(
	ref: RefObject<HTMLElement | null>,
	enabled: boolean,
	ignore: string,
) {
	const [at, setAt] = useState<MenuPoint | null>(null);
	useEffect(() => {
		const element = ref.current;
		if (!element || !enabled) return;
		const onContextMenu = (e: MouseEvent) => {
			const target = e.target as Element | null;
			if (target?.closest(ignore)) return;
			e.preventDefault();
			setAt(contextMenuPoint(e, element));
		};
		element.addEventListener("contextmenu", onContextMenu);
		return () => element.removeEventListener("contextmenu", onContextMenu);
	}, [ref, enabled, ignore]);
	const close = useCallback(() => setAt(null), []);
	return { at, close };
}

type EventHandlers = Record<string, (event: SyntheticEvent) => void>;

/**
 * The drag library's listeners, minus the events that come from a portal:
 * a drag only starts from the card itself, never from its menu or dialog.
 */
export function withoutPortalEvents(
	listeners: Record<string, unknown> | undefined,
): EventHandlers {
	const own: EventHandlers = {};
	for (const [name, handler] of Object.entries(listeners ?? {})) {
		own[name] = (event) => {
			if (!isFromPortal(event)) (handler as (e: SyntheticEvent) => void)(event);
		};
	}
	return own;
}

interface PointerMenuProps {
	at: MenuPoint;
	onClose: () => void;
	label: string;
	children: ReactNode;
}

/**
 * A menu opened by a right-click, at the pointer. It is the app's dropdown
 * menu anchored on a zero-size point in the body (a card moved by the drag
 * library would shift a fixed anchor placed inside it), and not modal, so a
 * right-click elsewhere closes it and opens the next one.
 */
export function PointerMenu({ at, onClose, label, children }: PointerMenuProps) {
	return (
		<DropdownMenu
			open
			modal={false}
			// Always open while shown: the only change it reports is closing.
			onOpenChange={onClose}
		>
			{createPortal(
				<DropdownMenuTrigger asChild>
					<span
						aria-hidden="true"
						data-pointer-menu-anchor=""
						style={{
							position: "fixed",
							left: at.x,
							top: at.y,
							width: 0,
							height: 0,
						}}
					/>
				</DropdownMenuTrigger>,
				document.body,
			)}
			<DropdownMenuContent
				align="start"
				sideOffset={2}
				// Named by its label: the anchor it is attached to has no text.
				aria-labelledby={undefined}
				aria-label={label}
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
