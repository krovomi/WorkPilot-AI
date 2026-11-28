/**
 * The toolbar entry of « Interroger le tableau » and its panel
 * (docs/architecture/board-ask.md).
 */

import { MessageSquareText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task } from "../../../../shared/types";
import { useBoardAskStore } from "../../../stores/board-ask-store";
import { Button } from "../../ui/button";
import { BoardAskPanel } from "./BoardAskPanel";

export interface BoardAskButtonProps {
	readonly projectId: string;
	readonly onOpenTask?: (task: Task) => void;
	/** A board of the server: its cards only, read from the server. */
	readonly serverBoard?: boolean;
}

export function BoardAskButton({ projectId, onOpenTask, serverBoard = false }: BoardAskButtonProps) {
	const { t } = useTranslation(["tasks"]);
	const setOpen = useBoardAskStore((s) => s.setOpen);
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				className="h-8 gap-1.5 rounded-full text-muted-foreground hover:text-foreground"
				onClick={() => setOpen(true)}
				title={t("kanban.ask.open")}
			>
				<MessageSquareText className="h-4 w-4" aria-hidden />
				<span className="text-xs font-medium">{t("kanban.ask.button")}</span>
			</Button>
			<BoardAskPanel projectId={projectId} onOpenTask={onOpenTask} serverBoard={serverBoard} />
		</>
	);
}
