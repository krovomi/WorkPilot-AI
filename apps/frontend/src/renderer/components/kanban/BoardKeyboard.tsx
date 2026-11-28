import { useTranslation } from "react-i18next";
import { TASK_STATUS_LABELS, type TaskStatusColumn } from "../../../shared/constants/task";
import { useBoardShortcuts } from "../../hooks/useBoardShortcuts";
import { useShortcutsHelpStore } from "../../stores/shortcuts-help-store";
import { ReadinessDialog } from "../task-readiness/ReadinessDialog";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";

interface BoardKeyboardProps {
	onSelectColumn: (status: string) => void;
	hasSelection: boolean;
	onClearSelection: () => void;
	onDeleteSelection: () => void;
	onUndo: () => void;
	/** The board's aria-live region. */
	announce: (message: string) => void;
}

/**
 * The board's keys (useBoardShortcuts), their help dialog, and the dialog of
 * the cards the pre-analysis held before they start. An arrow
 * that moves the focus says where it landed: "2 of 5, Queue".
 */
export function BoardKeyboard({ announce, ...shortcuts }: BoardKeyboardProps) {
	const { t } = useTranslation(["tasks"]);
	const setHelpOpen = useShortcutsHelpStore((s) => s.setOpen);
	useBoardShortcuts({
		...shortcuts,
		onShowShortcuts: () => setHelpOpen(true),
		onCardFocus: (focus) =>
			announce(
				t("tasks:kanban.a11y.cardFocus", {
					position: focus.position,
					count: focus.count,
					column: t(TASK_STATUS_LABELS[focus.status as TaskStatusColumn]),
				}),
			),
	});
	return (
		<>
			<ShortcutsHelpDialog />
			{/* Cards the pre-analysis held back before « En cours ». */}
			<ReadinessDialog />
		</>
	);
}
