/**
 * The toolbar's « Couloirs » menu: how the board is cut into lanes
 * (kanban/BoardLanes.tsx), whether flagged cards get the first lane, and,
 * for sub-projects, a lane added by name to drag cards into.
 *
 * Design: docs/architecture/kanban-swimlanes.md.
 */
import { Check, Plus, Rows3 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isEditableGrouping, LANE_GROUPINGS, MAX_AREA_LENGTH } from "../../lib/kanban-lanes";
import { cn } from "../../lib/utils";
import { useKanbanLanesStore } from "../../stores/kanban-lanes-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";

export function LaneGroupingMenu() {
	const { t } = useTranslation(["tasks"]);
	const grouping = useKanbanLanesStore((s) => s.grouping);
	const pinFlagged = useKanbanLanesStore((s) => s.pinFlagged);
	const setGrouping = useKanbanLanesStore((s) => s.setGrouping);
	const togglePinFlagged = useKanbanLanesStore((s) => s.togglePinFlagged);
	const addArea = useKanbanLanesStore((s) => s.addArea);
	const [areaName, setAreaName] = useState("");
	const [areaRefused, setAreaRefused] = useState(false);
	const active = grouping !== "none";

	const commitArea = () => {
		if (!areaName.trim()) return;
		if (addArea(areaName)) {
			setAreaName("");
			setAreaRefused(false);
		} else {
			setAreaRefused(true);
		}
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={cn(
						"h-8 gap-2 rounded-full text-muted-foreground hover:text-foreground transition-colors",
						active && "bg-primary/10 text-primary hover:text-primary",
					)}
					title={t("tasks:kanban.lanes.title")}
				>
					<Rows3 className="h-4 w-4" />
					{active
						? t("tasks:kanban.lanes.buttonActive", { grouping: t(`tasks:kanban.lanes.groupings.${grouping}`) })
						: t("tasks:kanban.lanes.button")}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-72 p-0 overflow-hidden">
				<div className="flex items-center gap-2 border-b border-border/60 bg-linear-to-br from-primary/5 to-transparent px-4 py-2.5">
					<Rows3 className="h-4 w-4 text-primary" />
					<h3 className="text-sm font-semibold">{t("tasks:kanban.lanes.title")}</h3>
				</div>
				<div className="space-y-3 p-3">
					<div className="space-y-0.5">
						{LANE_GROUPINGS.map((option) => (
							<button
								key={option}
								type="button"
								aria-pressed={grouping === option}
								onClick={() => setGrouping(option)}
								className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60 transition-colors"
							>
								<Check
									className={cn("h-3.5 w-3.5 text-primary", grouping !== option && "invisible")}
									aria-hidden="true"
								/>
								<span className="flex-1">{t(`tasks:kanban.lanes.groupings.${option}`)}</span>
								{option !== "none" && !isEditableGrouping(option) && (
									<span className="text-2xs text-muted-foreground">{t("tasks:kanban.lanes.readOnly")}</span>
								)}
							</button>
						))}
					</div>
					<Separator />
					<div className="flex items-center justify-between gap-3 px-0.5 text-sm">
						<label htmlFor="kanban-lanes-pin-flagged">{t("tasks:kanban.lanes.pinFlagged")}</label>
						<Switch
							id="kanban-lanes-pin-flagged"
							checked={pinFlagged}
							onCheckedChange={togglePinFlagged}
							disabled={!active}
						/>
					</div>
					{grouping === "area" && (
						<>
							<Separator />
							<div className="space-y-1.5">
								<div className="flex items-center gap-2">
									<Input
										value={areaName}
										maxLength={MAX_AREA_LENGTH}
										onChange={(e) => {
											setAreaName(e.target.value);
											setAreaRefused(false);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") commitArea();
										}}
										placeholder={t("tasks:kanban.lanes.addAreaPlaceholder")}
										aria-label={t("tasks:kanban.lanes.addArea")}
										className="h-8"
									/>
									<Button
										size="icon"
										className="h-8 w-8 shrink-0"
										disabled={!areaName.trim()}
										onClick={commitArea}
										aria-label={t("tasks:kanban.lanes.addArea")}
									>
										<Plus className="h-4 w-4" />
									</Button>
								</div>
								<p className={cn("px-0.5 text-xs", areaRefused ? "text-destructive" : "text-muted-foreground")}>
									{areaRefused ? t("tasks:kanban.lanes.addAreaRefused") : t("tasks:kanban.lanes.addAreaHint")}
								</p>
							</div>
						</>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
