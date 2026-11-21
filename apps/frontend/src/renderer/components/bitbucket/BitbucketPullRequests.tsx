/**
 * The pull requests and pipelines of the project's Bitbucket repository: two
 * tabs. A pull request shows its branches, description, changed files, diff
 * (cut at a bound by the main process) and comments; a pipeline shows its
 * steps. Text from Bitbucket is shown as plain text, never as HTML.
 */

import { GitPullRequest, Loader2, Play, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { BitbucketPipeline, BitbucketPullRequest, BitbucketPullRequestState } from "../../../shared/types";
import { formatAppDateTime } from "../../lib/date-format";
import { cn } from "../../lib/utils";
import { checkBitbucketConnection, useBitbucketIssuesStore } from "../../stores/bitbucket-issues-store";
import {
	loadBitbucketPipelineSteps,
	loadBitbucketPipelines,
	loadBitbucketPullRequestDetail,
	loadBitbucketPullRequests,
	useBitbucketPrStore,
} from "../../stores/bitbucket-pr-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { NativeSelect } from "../ui/native-select";
import { byLine, NotConnected, OpenInBitbucket } from "./shared";

const STATES: BitbucketPullRequestState[] = ["OPEN", "MERGED", "DECLINED"];
type Tab = "pullRequests" | "pipelines";
/** One empty list, so a selector that finds nothing returns the same value. */
const NONE: never[] = [];

interface BitbucketPullRequestsProps {
	readonly projectId: string;
	readonly onOpenSettings?: () => void;
}

export function BitbucketPullRequests({ projectId, onOpenSettings }: BitbucketPullRequestsProps) {
	const { t } = useTranslation("bitbucket");
	const syncStatus = useBitbucketIssuesStore((s) => (s.projectId === projectId ? s.syncStatus : null));
	const [tab, setTab] = useState<Tab>("pullRequests");

	useEffect(() => {
		void checkBitbucketConnection(projectId).then((connected) => {
			if (connected) void loadBitbucketPullRequests(projectId);
		});
	}, [projectId]);

	useEffect(() => {
		if (tab === "pipelines" && syncStatus?.connected) void loadBitbucketPipelines(projectId);
	}, [tab, projectId, syncStatus?.connected]);

	if (!syncStatus) return <EmptyState icon={Loader2} description={t("checking")} />;
	if (!syncStatus.connected) return <NotConnected error={syncStatus.error} onOpenSettings={onOpenSettings} />;

	return (
		<div className="flex h-full flex-col">
			<div className="flex gap-1 border-b border-border px-3 pt-2" role="tablist">
				{(["pullRequests", "pipelines"] as const).map((id) => (
					<button
						key={id}
						type="button"
						role="tab"
						aria-selected={tab === id}
						onClick={() => setTab(id)}
						className={cn(
							"px-3 py-1.5 text-sm border-b-2 -mb-px",
							tab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground",
						)}
					>
						{t(`tabs.${id}`)}
					</button>
				))}
			</div>
			<div className="flex-1 min-h-0">
				{tab === "pullRequests" ? <PullRequestsTab projectId={projectId} /> : <PipelinesTab projectId={projectId} />}
			</div>
		</div>
	);
}

function PullRequestsTab({ projectId }: { readonly projectId: string }) {
	const { t } = useTranslation("bitbucket");
	const view = useBitbucketPrStore(
		useShallow((s) => ({
			state: s.state,
			pullRequests: s.projectId === projectId ? s.pullRequests : NONE,
			isLoading: s.isLoading,
			error: s.error,
			selectedId: s.selectedId,
		})),
	);
	const selectPullRequest = useBitbucketPrStore((s) => s.selectPullRequest);
	const selected = view.pullRequests.find((p) => p.id === view.selectedId) ?? null;

	const choose = (pr: BitbucketPullRequest) => {
		selectPullRequest(pr.id);
		void loadBitbucketPullRequestDetail(projectId, pr.id);
	};

	return (
		<div className="flex h-full">
			<div className="w-1/2 border-r border-border flex flex-col min-w-0">
				<div className="flex items-center gap-2 p-3 border-b border-border">
					<NativeSelect
						aria-label={t("pullRequests.filter")}
						value={view.state}
						onChange={(e) =>
							void loadBitbucketPullRequests(projectId, e.target.value as BitbucketPullRequestState)
						}
					>
						{STATES.map((s) => (
							<option key={s} value={s}>
								{t(`pullRequests.states.${s}`)}
							</option>
						))}
					</NativeSelect>
					<Button
						variant="outline"
						size="icon"
						aria-label={t("refresh")}
						onClick={() => void loadBitbucketPullRequests(projectId)}
						disabled={view.isLoading}
					>
						<RefreshCw className={cn("h-4 w-4", view.isLoading && "animate-spin")} />
					</Button>
				</div>
				{view.error && (
					<p role="alert" className="px-3 py-2 text-xs text-destructive border-b border-border">
						{view.error}
					</p>
				)}
				<ul className="flex-1 overflow-y-auto">
					{view.pullRequests.map((pr) => (
						<li key={pr.id} className={cn("border-b border-border/50", pr.id === view.selectedId && "bg-accent")}>
							<button type="button" className="w-full px-3 py-2 text-left" onClick={() => choose(pr)}>
								<span className="block truncate text-sm text-foreground">{pr.title}</span>
								<span className="block truncate text-xs text-muted-foreground">
									#{pr.id} · {pr.sourceBranch} → {pr.destinationBranch}
									{pr.draft && ` · ${t("pullRequests.draft")}`}
								</span>
							</button>
						</li>
					))}
				</ul>
				{!view.isLoading && view.pullRequests.length === 0 && (
					<EmptyState icon={GitPullRequest} description={t("pullRequests.none")} />
				)}
			</div>
			<div className="w-1/2 flex flex-col min-w-0">
				{selected ? (
					<PullRequestDetail pr={selected} />
				) : (
					<EmptyState icon={GitPullRequest} description={t("pullRequests.select")} />
				)}
			</div>
		</div>
	);
}

function PullRequestDetail({ pr }: { readonly pr: BitbucketPullRequest }) {
	const { t } = useTranslation("bitbucket");
	const diff = useBitbucketPrStore((s) => s.diffs[pr.id]);
	const comments = useBitbucketPrStore((s) => s.comments[pr.id]);
	const detailError = useBitbucketPrStore((s) => s.detailError);
	return (
		<div className="flex-1 overflow-y-auto p-4 space-y-4">
			<div className="space-y-2">
				<h2 className="text-lg font-semibold text-foreground break-words">{pr.title}</h2>
				<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<Badge variant="outline">{t(`pullRequests.states.${pr.state}`, { defaultValue: pr.state })}</Badge>
					<span>{byLine(pr.author, pr.createdOn)}</span>
				</div>
				<p className="text-xs text-muted-foreground">
					{t("pullRequests.branches", { source: pr.sourceBranch, destination: pr.destinationBranch })}
				</p>
				<OpenInBitbucket url={pr.webUrl} />
			</div>
			{detailError && (
				<p role="alert" className="text-xs text-destructive">
					{detailError}
				</p>
			)}
			<p className="whitespace-pre-wrap break-words text-sm text-foreground">
				{pr.description || t("pullRequests.noDescription")}
			</p>
			<section className="space-y-2">
				<h3 className="text-sm font-medium text-foreground">{t("pullRequests.files")}</h3>
				{!diff && <p className="text-xs text-muted-foreground">{t("pullRequests.loadingDiff")}</p>}
				{diff?.files.map((f) => (
					<div key={f.path} className="flex justify-between gap-2 text-xs">
						<span className="truncate font-mono text-foreground">{f.path}</span>
						<span className="shrink-0">
							<span className="text-success">+{f.linesAdded}</span>{" "}
							<span className="text-destructive">-{f.linesRemoved}</span>
						</span>
					</div>
				))}
				{diff?.truncated && <p className="text-xs text-warning">{t("pullRequests.diffTruncated")}</p>}
				{diff?.diff && (
					<pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-2 text-xs font-mono">{diff.diff}</pre>
				)}
			</section>
			<section className="space-y-2">
				<h3 className="text-sm font-medium text-foreground">{t("comments.title")}</h3>
				{comments === undefined && <p className="text-xs text-muted-foreground">{t("comments.loading")}</p>}
				{comments?.length === 0 && <p className="text-xs text-muted-foreground">{t("comments.none")}</p>}
				{comments?.map((c) => (
					<div key={c.id} className="rounded-md border border-border p-2">
						<p className="text-xs text-muted-foreground">
							{byLine(c.author, c.createdOn)}
							{c.path && ` · ${c.path}${c.line ? `:${c.line}` : ""}`}
						</p>
						<p className="whitespace-pre-wrap break-words text-sm text-foreground">{c.content}</p>
					</div>
				))}
			</section>
		</div>
	);
}

const STATE_BADGE: Record<string, "success" | "destructive" | "info" | "muted"> = {
	SUCCESSFUL: "success",
	FAILED: "destructive",
	ERROR: "destructive",
	IN_PROGRESS: "info",
	PENDING: "info",
};

function PipelinesTab({ projectId }: { readonly projectId: string }) {
	const { t } = useTranslation("bitbucket");
	const view = useBitbucketPrStore(
		useShallow((s) => ({
			pipelines: s.projectId === projectId ? s.pipelines : NONE,
			isLoading: s.pipelinesLoading,
			error: s.pipelinesError,
			steps: s.steps,
		})),
	);
	const [open, setOpen] = useState<string | null>(null);

	const toggle = (p: BitbucketPipeline) => {
		setOpen(open === p.uuid ? null : p.uuid);
		if (open !== p.uuid && !view.steps[p.uuid]) void loadBitbucketPipelineSteps(projectId, p.uuid);
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-end gap-2 p-3 border-b border-border">
				<Button
					variant="outline"
					size="icon"
					aria-label={t("refresh")}
					onClick={() => void loadBitbucketPipelines(projectId)}
					disabled={view.isLoading}
				>
					<RefreshCw className={cn("h-4 w-4", view.isLoading && "animate-spin")} />
				</Button>
			</div>
			{view.error && (
				<p role="alert" className="px-3 py-2 text-xs text-destructive border-b border-border">
					{view.error}
				</p>
			)}
			<ul className="flex-1 overflow-y-auto">
				{view.pipelines.map((p) => (
					<li key={p.uuid} className="border-b border-border/50 px-3 py-2">
						<div className="flex items-center gap-3">
							<button
								type="button"
								aria-expanded={open === p.uuid}
								className="flex flex-1 min-w-0 items-center gap-3 text-left"
								onClick={() => toggle(p)}
							>
								<Badge variant={STATE_BADGE[p.state] ?? "muted"}>
									{t(`pipelines.states.${p.state}`, { defaultValue: p.state })}
								</Badge>
								<span className="text-sm text-foreground">
									{t("pipelines.build", { number: p.buildNumber })}
								</span>
								<span className="truncate text-xs text-muted-foreground">
									{p.branch ? `${p.branch} · ` : ""}
									{formatAppDateTime(p.createdOn)}
								</span>
							</button>
							<OpenInBitbucket url={p.webUrl} />
						</div>
						{open === p.uuid && (
							<ul className="mt-2 space-y-1 pl-6">
								{(view.steps[p.uuid] ?? []).map((s) => (
									<li key={s.uuid} className="flex items-center gap-2 text-xs">
										<Play className="h-3 w-3 text-muted-foreground" />
										<span className="text-foreground">{s.name}</span>
										<Badge variant={STATE_BADGE[s.state] ?? "muted"}>
											{t(`pipelines.states.${s.state}`, { defaultValue: s.state })}
										</Badge>
									</li>
								))}
							</ul>
						)}
					</li>
				))}
			</ul>
			{!view.isLoading && view.pipelines.length === 0 && (
				<EmptyState icon={Play} description={t("pipelines.none")} />
			)}
		</div>
	);
}
