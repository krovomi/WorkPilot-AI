import { History, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemoryJournalEntry, MemoryRevertMode } from "../../../../shared/types";
import { formatAppDateTime } from "../../../lib/date-format";
import { Button } from "../../ui/button";
import { entryLabel, shortPath } from "./lifecycle-labels";

interface MemoryTimelineProps {
	readonly entries: MemoryJournalEntry[];
	/** Show which memory each entry is about (the project journal). */
	readonly showNote?: boolean;
	/** Entry id → how a person can take it back (the project journal). */
	readonly revertible?: Record<string, MemoryRevertMode>;
	readonly onRevert?: (entryId: string) => void;
}

/** Journal entries, newest first: one memory's timeline, or the project's. */
export function MemoryTimeline({
	entries,
	showNote = false,
	revertible = {},
	onRevert,
}: MemoryTimelineProps) {
	const { t } = useTranslation(["context"]);
	if (entries.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				{t("context:lifecycle.journal.empty")}
			</p>
		);
	}
	return (
		<ol className="space-y-2" data-testid="memory-timeline">
			{entries.map((entry) => (
				<li key={entry.id} className="flex gap-2 text-xs">
					<History className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
					<div className="min-w-0 space-y-0.5">
						<div className="text-foreground">
							<span className="text-muted-foreground">
								{formatAppDateTime(entry.ts)}
							</span>{" "}
							{entryLabel(t, entry)}
						</div>
						{showNote && (
							<div className="truncate text-muted-foreground">
								<code>{shortPath(entry.note)}</code>
								{entry.title && <span className="ml-2">{entry.title}</span>}
							</div>
						)}
						{entry.reason && (
							<div className="text-muted-foreground italic">{entry.reason}</div>
						)}
					</div>
					{onRevert && revertible[entry.id] && (
						<Button
							size="sm"
							variant="ghost"
							className="ml-auto h-6 shrink-0 gap-1 px-2 text-xs"
							onClick={() => onRevert(entry.id)}
						>
							<Undo2 className="h-3 w-3" />
							{t(`context:lifecycle.undo.${revertible[entry.id]}`)}
						</Button>
					)}
				</li>
			))}
		</ol>
	);
}
