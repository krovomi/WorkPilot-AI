import {
	AlertTriangle,
	GitMerge,
	History,
	Pin,
	RefreshCw,
	RotateCcw,
	Trash2,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatAppDateTime } from "../../../lib/date-format";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { ScrollArea } from "../../ui/scroll-area";
import { ConflictResolver } from "./ConflictResolver";
import { LifecycleMetrics } from "./LifecycleMetrics";
import { MaintainersEditor } from "./MaintainersEditor";
import { entryLabel, errorLabel, shortPath } from "./lifecycle-labels";
import { MemoryTimeline } from "./MemoryTimeline";
import { useMemoryLifecycle } from "./useMemoryLifecycle";

interface LifecycleTabProps {
	readonly projectId: string;
	/**
	 * A server project's memory: its own brain on the server, which no git
	 * sync feeds, so there is no conflict between teammates' notes to resolve.
	 */
	readonly onServer?: boolean;
}

/** The memory's journal, its trash and the sync conflicts to resolve. */
export function LifecycleTab({ projectId, onServer = false }: LifecycleTabProps) {
	const { t } = useTranslation(["context"]);
	const { view, loading, error, reload } = useMemoryLifecycle(projectId);
	const [notice, setNotice] = useState<string | null>(null);

	const restore = async (trashId: string) => {
		const result = await window.electronAPI.restoreMemory(projectId, trashId);
		if (!result.success) {
			setNotice(errorLabel(t, result.error));
		} else if (result.data && result.data.contradicts.length > 0) {
			setNotice(t("context:lifecycle.trash.contradicts", { count: result.data.contradicts.length }));
		} else {
			setNotice(t("context:lifecycle.trash.restored"));
		}
		await reload();
	};

	const revert = async (entryId: string) => {
		const result = await window.electronAPI.revertMemoryDecision(projectId, entryId);
		if (!result.success) setNotice(errorLabel(t, result.error));
		else if (result.data?.conflict) setNotice(t("context:lifecycle.undo.queued"));
		else setNotice(t("context:lifecycle.undo.done"));
		await reload();
	};

	const expiring = view?.trash.filter((item) => item.expiring_soon).length ?? 0;
	const lastUndo = view?.journal.find((entry) => entry.id === view.lastUndo);
	const decisions = view?.journal.filter((entry) => entry.action === "resolve") ?? [];

	return (
		<ScrollArea className="h-full">
			<div className="mx-auto max-w-5xl space-y-5 px-5 pt-2 pb-6" data-testid="memory-lifecycle">
				<div className="flex items-center justify-between gap-2">
					{view && (
						<Badge variant="outline" className="gap-1">
							<Pin className="h-3 w-3" />
							{t("context:lifecycle.pins", { count: view.pinned, limit: view.pinLimit })}
						</Badge>
					)}
					<Button variant="ghost" size="sm" className="ml-auto gap-1" disabled={loading} onClick={reload}>
						<RefreshCw className={loading ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
						{t("context:lifecycle.refresh")}
					</Button>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{t("context:lifecycle.error", { error: errorLabel(t, error) })}
					</p>
				)}
				{notice && (
					<p role="status" className="text-sm text-muted-foreground">
						{notice}
					</p>
				)}

				{lastUndo && (
					<div
						className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3 text-xs"
						data-testid="memory-last-undo"
					>
						<div className="min-w-0">
							<div className="font-medium text-foreground">{t("context:lifecycle.undo.last")}</div>
							<div className="truncate text-muted-foreground">
								{entryLabel(t, lastUndo)} · <code>{shortPath(lastUndo.note)}</code>
							</div>
						</div>
						<Button size="sm" variant="outline" className="shrink-0 gap-1" onClick={() => revert(lastUndo.id)}>
							<Undo2 className="h-3.5 w-3.5" />
							{t("context:lifecycle.undo.undo")}
						</Button>
					</div>
				)}

				{onServer && (
					<p className="text-xs text-muted-foreground" data-testid="memory-server-note">
						{t("context:lifecycle.serverProject")}
					</p>
				)}

				{!onServer && (
				<section className="space-y-3">
					<h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
						<GitMerge className="h-4 w-4" />
						{t("context:lifecycle.conflicts.title")}
					</h3>
					{view && (
						<MaintainersEditor projectId={projectId} maintainers={view.maintainers} onSaved={reload} />
					)}
					{view && view.conflicts.length === 0 && (
						<p className="text-xs text-muted-foreground">{t("context:lifecycle.conflicts.empty")}</p>
					)}
					{view?.conflicts.map((conflict) => (
						<ConflictResolver
							key={conflict.id}
							projectId={projectId}
							conflict={conflict}
							onResolved={reload}
							canArbitrate={view.canArbitrate}
							maintainers={view.maintainers}
						/>
					))}
				</section>
				)}

				{decisions.length > 0 && (
					<Card data-testid="memory-decisions">
						<CardHeader className="pb-3">
							<CardTitle className="flex items-center gap-2 text-base">
								<GitMerge className="h-4 w-4" />
								{t("context:lifecycle.decisions.title")}
							</CardTitle>
						</CardHeader>
						<CardContent>
							<MemoryTimeline entries={decisions} showNote />
						</CardContent>
					</Card>
				)}

				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="flex items-center gap-2 text-base">
							<Trash2 className="h-4 w-4" />
							{t("context:lifecycle.trash.title")}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{expiring > 0 && (
							<p className="flex items-center gap-2 text-xs text-warning">
								<AlertTriangle className="h-3.5 w-3.5" />
								{t("context:lifecycle.trash.expiring", { count: expiring })}
							</p>
						)}
						{view && view.trash.length === 0 && (
							<p className="text-xs text-muted-foreground">{t("context:lifecycle.trash.empty")}</p>
						)}
						{view?.trash.map((item) => (
							<div
								key={item.id}
								className="flex items-start justify-between gap-3 rounded-lg border border-border/50 p-3"
							>
								<div className="min-w-0 space-y-1 text-xs">
									<div className="font-medium text-foreground">{item.title || item.preview}</div>
									<code className="text-muted-foreground">{shortPath(item.path)}</code>
									<div className="text-muted-foreground">
										{t("context:lifecycle.trash.until", {
											date: formatAppDateTime(item.restore_until),
										})}
									</div>
									{item.reason && <div className="italic text-muted-foreground">{item.reason}</div>}
								</div>
								<Button size="sm" variant="outline" className="shrink-0 gap-1" onClick={() => restore(item.id)}>
									<RotateCcw className="h-3.5 w-3.5" />
									{t("context:lifecycle.trash.restore")}
								</Button>
							</div>
						))}
					</CardContent>
				</Card>

				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="flex items-center gap-2 text-base">
							<History className="h-4 w-4" />
							{t("context:lifecycle.journal.title")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						{view && (
							<MemoryTimeline
								entries={view.journal}
								showNote
								revertible={view.revertible}
								onRevert={revert}
							/>
						)}
					</CardContent>
				</Card>

				{view?.metrics && <LifecycleMetrics metrics={view.metrics} />}
			</div>
		</ScrollArea>
	);
}
