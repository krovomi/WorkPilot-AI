import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { orderedSprints } from "../../../shared/utils/sprints";
import { useSprintStore } from "../../stores/sprint-store";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";

interface SprintChoiceMenuItemsProps {
	/** The card's sprint id, or null in the backlog. */
	current?: string | null;
	/** A sprint id, or null to send the card back to the backlog. */
	onSelect: (sprintId: string | null) => void;
}

/**
 * The sprints a card can join (the active one and the planned ones), and
 * the backlog, as menu items: the card menu's « Sprint » entry. A closed
 * sprint no longer takes cards. Design: docs/architecture/kanban-sprints.md.
 */
export function SprintChoiceMenuItems({ current, onSelect }: SprintChoiceMenuItemsProps) {
	const { t } = useTranslation(["tasks"]);
	const sprints = useSprintStore((s) => s.sprints);
	const open = orderedSprints(sprints).filter((sprint) => sprint.state !== "closed");
	return (
		<>
			<DropdownMenuItem onSelect={() => onSelect(null)}>
				{t("tasks:kanban.sprints.backlog")}
				{!current && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
			</DropdownMenuItem>
			{open.length > 0 && <DropdownMenuSeparator />}
			{open.map((sprint) => (
				<DropdownMenuItem key={sprint.id} onSelect={() => onSelect(sprint.id)} className="gap-2">
					<span className="max-w-[12rem] truncate">{sprint.name}</span>
					{sprint.state === "active" && (
						<span className="rounded bg-primary/15 px-1 text-2xs font-semibold text-primary">
							{t("tasks:kanban.sprints.states.active")}
						</span>
					)}
					{current === sprint.id && <Check className="ml-auto h-3.5 w-3.5" aria-hidden="true" />}
				</DropdownMenuItem>
			))}
			{open.length === 0 && (
				<DropdownMenuItem disabled>{t("tasks:kanban.sprints.noneToJoin")}</DropdownMenuItem>
			)}
		</>
	);
}
