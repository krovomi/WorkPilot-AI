import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../shared/types";
import { renameCard } from "../lib/card-edits";
import { toast } from "./use-toast";

/** How long a click on a title waits for a second one before opening the card. */
export const TITLE_DOUBLE_CLICK_MS = 250;

interface InlineRenameOptions {
	task: Task;
	/** False while an agent works on the card. */
	canRename: boolean;
	onOpen: () => void;
	focusCard: () => void;
}

/**
 * Renaming a card in place: double-click on its title or F2. A click on the
 * title of a card that can be renamed opens it after a short wait, so the
 * second click of a double-click never lands on the opened card.
 * Design: docs/architecture/kanban-quick-edit.md.
 */
export function useInlineRename({ task, canRename, onOpen, focusCard }: InlineRenameOptions) {
	const { t } = useTranslation(["tasks"]);
	const [isRenaming, setIsRenaming] = useState(false);
	const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(openTimer.current), []);

	const start = useCallback(() => {
		if (canRename) setIsRenaming(true);
	}, [canRename]);

	/** True when the click was on the title and is handled here. */
	const onTitleClick = (e: MouseEvent): boolean => {
		if (!canRename || !(e.target as Element).closest("[data-card-title]")) return false;
		clearTimeout(openTimer.current);
		if (e.detail >= 2) setIsRenaming(true);
		else openTimer.current = setTimeout(onOpen, TITLE_DOUBLE_CLICK_MS);
		return true;
	};

	const finish = (title: string | null, byKey: boolean) => {
		setIsRenaming(false);
		if (byKey) focusCard();
		if (title === null) return;
		void renameCard(task, title, t("tasks:kanban.undoLabels.rename")).then((saved) => {
			if (!saved) toast({ variant: "destructive", title: t("tasks:kanban.cardMenu.saveFailed") });
		});
	};

	return { isRenaming, start, onTitleClick, finish };
}
