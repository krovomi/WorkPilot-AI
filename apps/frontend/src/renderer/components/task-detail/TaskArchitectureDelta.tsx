import { AlertTriangle, GitCompareArrows, Loader2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ArchitectureDeltaSummary } from "../../../main/architecture-visualizer-service";
import type { Task } from "../../../shared/types";
import {
	type ArchitectureDeltaEntry,
	useArchitectureDeltaStore,
} from "../../stores/architecture-delta-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface TaskArchitectureDeltaProps {
	readonly task: Task;
	readonly projectPath?: string;
	/** Loaded by the modal: the record is what decides the tab exists. */
	readonly entry: ArchitectureDeltaEntry | undefined;
}

/**
 * What this task changed in the system's topology, not just in its files.
 *
 * The tab renders nothing at all in the two states where there is nothing to
 * say — the change was not architectural, or the comparison found no
 * difference. The predicate for that lives with the store
 * (`shouldShowArchitectureDelta`) and gates the trigger, so those states never
 * produce a tab in the first place.
 *
 * The `unreliable-ids` state is the one that earns its words. The comparator
 * matches components by id, so a model that renamed them produces a delta that
 * is entirely fictional; saying so costs a line, and showing it costs the
 * reader's trust in every delta after it.
 */
export function TaskArchitectureDelta({
	task,
	projectPath,
	entry,
}: TaskArchitectureDeltaProps) {
	const { t } = useTranslation(["architectureVisualizer"]);
	const regenerate = useArchitectureDeltaStore((s) => s.regenerate);

	const specDir = task.specsPath;
	const status = entry?.status ?? null;
	const counts = useMemo(() => summarise(status?.summary), [status?.summary]);

	if (!specDir) return null;

	if (entry?.running) {
		return (
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2 border-b border-border px-4 py-2">
					<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
					<span className="text-sm">
						{t("architectureVisualizer:delta.actions.running")}
					</span>
				</div>
				<pre className="flex-1 overflow-auto whitespace-pre-wrap p-4 font-mono text-xs text-muted-foreground">
					{entry.progress}
				</pre>
			</div>
		);
	}

	if (entry?.loading || !status) return null;

	const regenerateButton = (
		<Button
			size="sm"
			variant="outline"
			disabled={!projectPath}
			onClick={() =>
				projectPath &&
				void regenerate({
					taskId: task.id,
					projectDir: projectPath,
					specDir,
					taskSummary: task.description ?? task.title,
				})
			}
		>
			<RefreshCw className="mr-2 h-4 w-4" aria-hidden />
			{t("architectureVisualizer:delta.actions.regenerate")}
		</Button>
	);

	if (status.status === "no-baseline") {
		return (
			<Notice
				title={t("architectureVisualizer:delta.noBaseline.title")}
				body={t("architectureVisualizer:delta.noBaseline.body")}
				action={regenerateButton}
			/>
		);
	}

	if (status.status === "unreliable-ids") {
		return (
			<Notice
				tone="warning"
				title={t("architectureVisualizer:delta.unreliable.title")}
				body={t("architectureVisualizer:delta.unreliable.body", {
					kept: status.continuity.kept ?? 0,
					total: status.continuity.total ?? 0,
				})}
				action={regenerateButton}
			>
				{(status.continuity.lost?.length ?? 0) > 0 && (
					<div className="mt-3">
						<h4 className="text-xs font-medium">
							{t("architectureVisualizer:delta.unreliable.lost")}
						</h4>
						<div className="mt-1 flex flex-wrap gap-1">
							{status.continuity.lost?.map((id) => (
								<Badge key={id} variant="outline" className="text-[10px]">
									{id}
								</Badge>
							))}
						</div>
					</div>
				)}
			</Notice>
		);
	}

	if (status.status === "runtime-missing") {
		return (
			<Notice
				title={t("architectureVisualizer:delta.runtimeMissing.title")}
				body={status.reason}
			/>
		);
	}

	if (status.status === "failed") {
		return (
			<Notice
				tone="warning"
				title={t("architectureVisualizer:delta.failed.title")}
				body={status.reason || entry?.error || ""}
				action={regenerateButton}
			/>
		);
	}

	// `mapped` with nothing in it, and `not-significant`, both render nothing.
	if (!status.hasChanges) return null;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<GitCompareArrows
							className="h-4 w-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
						<span className="text-sm font-medium">
							{t("architectureVisualizer:delta.title")}
						</span>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{status.baselineRevision
							? t("architectureVisualizer:delta.subtitle", {
									revision: status.baselineRevision.slice(0, 12),
								})
							: t("architectureVisualizer:delta.subtitleNoRevision")}
					</p>
					<div className="mt-2 flex flex-wrap gap-1">
						{counts.map(({ key, count }) => (
							<Badge key={key} variant="outline" className="text-[10px]">
								{t(`architectureVisualizer:delta.counts.${key}`, { count })}
							</Badge>
						))}
					</div>
				</div>
				<div className="shrink-0">{regenerateButton}</div>
			</div>

			<div className="flex-1 min-h-0">
				{entry?.artifactUrl ? (
					<webview
						key={entry.artifactUrl}
						src={entry.artifactUrl}
						className="h-full w-full border-0"
					/>
				) : null}
			</div>
		</div>
	);
}

const COUNT_KEYS: Array<{
	key: string;
	group: keyof ArchitectureDeltaSummary;
	field: string;
}> = [
	{ key: "componentsAdded", group: "components", field: "added" },
	{ key: "componentsRemoved", group: "components", field: "removed" },
	{ key: "componentsChanged", group: "components", field: "changed" },
	{ key: "connectionsAdded", group: "connections", field: "added" },
	{ key: "connectionsRemoved", group: "connections", field: "removed" },
	{ key: "connectionsChanged", group: "connections", field: "changed" },
	{ key: "boundariesChanged", group: "boundaries", field: "changed" },
];

function summarise(
	summary: ArchitectureDeltaSummary | undefined,
): Array<{ key: string; count: number }> {
	if (!summary) return [];
	const out: Array<{ key: string; count: number }> = [];
	for (const { key, group, field } of COUNT_KEYS) {
		const bucket = summary[group];
		const count =
			typeof bucket === "object" && bucket !== null
				? ((bucket as Record<string, number>)[field] ?? 0)
				: 0;
		if (count > 0) out.push({ key, count });
	}
	return out;
}

function Notice({
	title,
	body,
	action,
	tone = "muted",
	children,
}: {
	readonly title: string;
	readonly body: string;
	readonly action?: ReactNode;
	readonly tone?: "muted" | "warning";
	readonly children?: ReactNode;
}) {
	return (
		<div className="flex h-full items-start justify-center p-6">
			<div className="max-w-md">
				<div className="flex items-center gap-2">
					{tone === "warning" && (
						<AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
					)}
					<h3 className="text-sm font-medium">{title}</h3>
				</div>
				{body && (
					<p className="mt-2 text-xs text-muted-foreground">{body}</p>
				)}
				{children}
				{action && <div className="mt-3">{action}</div>}
			</div>
		</div>
	);
}
