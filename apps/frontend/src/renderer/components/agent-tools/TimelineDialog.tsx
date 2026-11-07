import { useEffect, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import {
	type Timeline,
	type TimelineEntry,
	fetchTimeline,
} from "../../lib/agent-tools-api";
import { useTranslation } from "react-i18next";

export interface TimelineDialogProps {
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly projectDir: string;
	readonly correlationId: string;
}

const PHASE_COLORS: Record<string, string> = {
	planning: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
	coding: "bg-success/15 text-success ",
	qa: "bg-warning/15 text-warning ",
	documentation: "bg-purple-500/15 text-purple-700 dark:text-purple-300",
	system: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};

const KIND_ICONS: Record<string, string> = {
	agent_invoked: "▶",
	agent_completed: "✓",
	agent_failed: "✗",
	agent_paused: "⏸",
	decision_made: "◆",
	policy_violated: "⚠",
	system_event: "·",
};

function formatDelta(seconds: number): string {
	if (seconds < 1) return "0s";
	if (seconds < 60) return `+${seconds.toFixed(1)}s`;
	if (seconds < 3600) return `+${(seconds / 60).toFixed(1)}m`;
	return `+${(seconds / 3600).toFixed(1)}h`;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds.toFixed(0)}s`;
	if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
	return `${(seconds / 3600).toFixed(1)}h`;
}

function EntryRow({ entry }: { readonly entry: TimelineEntry }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const hasPayload = Object.keys(entry.payload).length > 0;
	const phaseClass = PHASE_COLORS[entry.phase] ?? PHASE_COLORS.system;
	const icon = KIND_ICONS[entry.kind] ?? "·";

	return (
		<div className="border-l-2 border-muted pl-3 py-2 hover:bg-muted/30 transition-colors">
			<div className="flex items-start gap-2">
				<span className="text-sm font-mono w-4 shrink-0">{icon}</span>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<Badge className={`text-3xs ${phaseClass}`}>
							{entry.actor}
						</Badge>
						<span className="text-xs text-muted-foreground font-mono">
							{entry.kind}
						</span>
						{entry.delta_seconds > 0 && (
							<span className="text-3xs text-muted-foreground">
								{formatDelta(entry.delta_seconds)}
							</span>
						)}
					</div>
					<div className="text-sm mt-0.5">{entry.summary}</div>
					{hasPayload && (
						<button
							type="button"
							className="text-3xs text-muted-foreground hover:text-foreground mt-1 cursor-pointer bg-transparent border-none p-0"
							onClick={() => setExpanded(!expanded)}
						>
							{expanded ? t("agentTools:timeline.hidePayload") : t("agentTools:timeline.showPayload")}
						</button>
					)}
					{expanded && hasPayload && (
						<pre className="mt-1 text-3xs bg-muted/50 p-2 rounded overflow-x-auto">
							{JSON.stringify(entry.payload, null, 2)}
						</pre>
					)}
				</div>
				<span className="text-3xs text-muted-foreground shrink-0 font-mono">
					#{entry.sequence}
				</span>
			</div>
		</div>
	);
}

export function TimelineDialog({
	open,
	onOpenChange,
	projectDir,
	correlationId,
}: TimelineDialogProps) {
	const { t } = useTranslation();
	const [timeline, setTimeline] = useState<Timeline | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setTimeline(null);
			setError(null);
			return;
		}
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		fetchTimeline(projectDir, correlationId, { signal: controller.signal })
			.then((res) => {
				if (res.ok) setTimeline(res.data.timeline);
				else if (res.error !== "aborted") setError(res.error);
			})
			.finally(() => setLoading(false));
		return () => controller.abort();
	}, [open, projectDir, correlationId]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>{t("agentTools:timeline.title")}</DialogTitle>
					<DialogDescription>
						{t("agentTools:timeline.descriptionBefore")}{" "}
						<code className="text-xs">{correlationId}</code>{t("agentTools:timeline.descriptionAfter")}
					</DialogDescription>
				</DialogHeader>

				{loading && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						{t("agentTools:timeline.loading")}
					</div>
				)}

				{error && (
					<div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive ">
						{error}
					</div>
				)}

				{timeline && (
					<div className="space-y-3">
						<div className="flex flex-wrap gap-2 text-xs">
							<Badge variant="outline">
								{t("agentTools:timeline.events", { count: timeline.entry_count })}
							</Badge>
							<Badge variant="outline">
								{t("agentTools:timeline.duration", {
									duration: formatDuration(timeline.duration_seconds),
								})}
							</Badge>
							{timeline.integrity.intact ? (
								<Badge className="bg-success/15 text-success ">
									{t("agentTools:timeline.chainIntact")}
								</Badge>
							) : (
								<Badge className="bg-destructive/15 text-destructive ">
									{t("agentTools:timeline.chainBroken", {
										reason: timeline.integrity.reason,
									})}
								</Badge>
							)}
							{Object.entries(timeline.phase_counts).map(([phase, count]) => (
								<Badge key={phase} className={PHASE_COLORS[phase] ?? PHASE_COLORS.system}>
									{phase}: {count}
								</Badge>
							))}
						</div>

						{timeline.entries.length === 0 ? (
							<div className="py-6 text-center text-sm text-muted-foreground">
								{t("agentTools:timeline.empty")}
							</div>
						) : (
							<ScrollArea className="h-96 rounded-md border">
								<div className="divide-y">
									{timeline.entries.map((entry) => (
										<EntryRow key={entry.event_hash || entry.sequence} entry={entry} />
									))}
								</div>
							</ScrollArea>
						)}
					</div>
				)}

				<DialogFooter>
					<Button onClick={() => onOpenChange(false)}>{t("common:buttons.close")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
