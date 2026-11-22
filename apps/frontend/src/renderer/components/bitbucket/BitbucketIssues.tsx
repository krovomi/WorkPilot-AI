/**
 * The issues of the project's Bitbucket repository: a list filtered by state
 * and by a search on the title, an issue's text and comments, and the import
 * of the checked issues (or the one on screen) as tasks. Issue text is shown
 * as plain text, never as HTML.
 */

import { Download, Inbox, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { BitbucketIssue, BitbucketIssueFilter } from "../../../shared/types";
import { cn } from "../../lib/utils";
import {
	checkBitbucketConnection,
	importBitbucketIssues,
	loadBitbucketIssueComments,
	loadBitbucketIssues,
	useBitbucketIssuesStore,
} from "../../stores/bitbucket-issues-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/native-select";
import { byLine, NotConnected, OpenInBitbucket } from "./shared";

const FILTERS: BitbucketIssueFilter[] = ["open", "closed", "all"];

interface BitbucketIssuesProps {
	readonly projectId: string;
	readonly onOpenSettings?: () => void;
}

export function BitbucketIssues({ projectId, onOpenSettings }: BitbucketIssuesProps) {
	const { t } = useTranslation("bitbucket");
	const view = useBitbucketIssuesStore(
		useShallow((s) => ({
			projectId: s.projectId,
			syncStatus: s.syncStatus,
			issues: s.issues,
			issuesEnabled: s.issuesEnabled,
			filter: s.filter,
			isLoading: s.isLoading,
			error: s.error,
			selectedId: s.selectedId,
			checked: s.checked,
			isImporting: s.isImporting,
			importResult: s.importResult,
		})),
	);
	const selectIssue = useBitbucketIssuesStore((s) => s.selectIssue);
	const toggleChecked = useBitbucketIssuesStore((s) => s.toggleChecked);
	const [search, setSearch] = useState("");

	useEffect(() => {
		void checkBitbucketConnection(projectId).then((connected) => {
			if (connected) void loadBitbucketIssues(projectId);
		});
	}, [projectId]);

	const shown = useMemo(() => {
		const query = search.trim().toLowerCase();
		return query ? view.issues.filter((i) => i.title.toLowerCase().includes(query)) : view.issues;
	}, [view.issues, search]);
	const selected = view.issues.find((i) => i.id === view.selectedId) ?? null;

	if (view.projectId !== projectId || !view.syncStatus) {
		return <EmptyState icon={Loader2} description={t("checking")} />;
	}
	if (!view.syncStatus.connected) {
		return <NotConnected error={view.syncStatus.error} onOpenSettings={onOpenSettings} />;
	}
	if (!view.issuesEnabled) {
		return <EmptyState icon={Inbox} title={t("issues.trackerOff")} description={t("issues.trackerOffDescription")} />;
	}

	const choose = (issue: BitbucketIssue) => {
		selectIssue(issue.id);
		void loadBitbucketIssueComments(projectId, issue.id);
	};

	return (
		<div className="flex h-full">
			<div className="w-1/2 border-r border-border flex flex-col min-w-0">
				<div className="flex flex-wrap items-center gap-2 p-3 border-b border-border">
					<NativeSelect
						aria-label={t("issues.filter")}
						value={view.filter}
						onChange={(e) => void loadBitbucketIssues(projectId, e.target.value as BitbucketIssueFilter)}
					>
						{FILTERS.map((f) => (
							<option key={f} value={f}>
								{t(`issues.filters.${f}`)}
							</option>
						))}
					</NativeSelect>
					<Input
						className="h-9 flex-1 min-w-32"
						aria-label={t("issues.search")}
						placeholder={t("issues.search")}
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
					<Button
						variant="outline"
						size="icon"
						aria-label={t("refresh")}
						onClick={() => void loadBitbucketIssues(projectId)}
						disabled={view.isLoading}
					>
						<RefreshCw className={cn("h-4 w-4", view.isLoading && "animate-spin")} />
					</Button>
					<Button
						size="sm"
						onClick={() => void importBitbucketIssues(projectId)}
						disabled={view.checked.length === 0 || view.isImporting}
					>
						<Download className="h-4 w-4 mr-1" />
						{t("issues.importChecked", { count: view.checked.length })}
					</Button>
				</div>
				{view.importResult && (
					<p
						role="status"
						className={cn(
							"px-3 py-2 text-xs border-b border-border",
							view.importResult.failed > 0 ? "text-warning" : "text-success",
						)}
					>
						{t("issues.importResult", {
							imported: view.importResult.imported,
							failed: view.importResult.failed,
						})}
						{view.importResult.errors?.map((e) => (
							<span key={e} className="block">
								{e}
							</span>
						))}
					</p>
				)}
				{view.error && (
					<p role="alert" className="px-3 py-2 text-xs text-destructive border-b border-border">
						{view.error}
					</p>
				)}
				<ul className="flex-1 overflow-y-auto">
					{shown.map((issue) => (
						<li
							key={issue.id}
							className={cn(
								"flex items-start gap-3 px-3 py-2 border-b border-border/50",
								issue.id === view.selectedId && "bg-accent",
							)}
						>
							<Checkbox
								className="mt-1"
								aria-label={t("issues.check", { id: issue.id })}
								checked={view.checked.includes(issue.id)}
								onCheckedChange={() => toggleChecked(issue.id)}
							/>
							<button type="button" className="flex-1 min-w-0 text-left" onClick={() => choose(issue)}>
								<span className="block truncate text-sm text-foreground">{issue.title}</span>
								<span className="text-xs text-muted-foreground">
									#{issue.id} · {t(`issues.states.${issue.state}`, { defaultValue: issue.state })}
								</span>
							</button>
						</li>
					))}
				</ul>
				{!view.isLoading && shown.length === 0 && (
					<EmptyState icon={Inbox} description={search ? t("issues.noMatch") : t("issues.none")} />
				)}
			</div>
			<div className="w-1/2 flex flex-col min-w-0">
				{selected ? (
					<IssueDetail projectId={projectId} issue={selected} isImporting={view.isImporting} />
				) : (
					<EmptyState icon={Inbox} description={t("issues.select")} />
				)}
			</div>
		</div>
	);
}

function IssueDetail({
	projectId,
	issue,
	isImporting,
}: {
	readonly projectId: string;
	readonly issue: BitbucketIssue;
	readonly isImporting: boolean;
}) {
	const { t } = useTranslation("bitbucket");
	const comments = useBitbucketIssuesStore((s) => s.comments[issue.id]);
	return (
		<div className="flex-1 overflow-y-auto p-4 space-y-4">
			<div className="space-y-2">
				<h2 className="text-lg font-semibold text-foreground break-words">{issue.title}</h2>
				<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<Badge variant="outline">{t(`issues.states.${issue.state}`, { defaultValue: issue.state })}</Badge>
					<Badge variant="muted">{t(`issues.kinds.${issue.kind}`, { defaultValue: issue.kind })}</Badge>
					<span>{byLine(issue.reporter, issue.createdOn)}</span>
				</div>
				<div className="flex gap-2">
					<Button size="sm" onClick={() => void importBitbucketIssues(projectId, [issue.id])} disabled={isImporting}>
						<Download className="h-4 w-4 mr-1" />
						{t("issues.importOne")}
					</Button>
					<OpenInBitbucket url={issue.webUrl} />
				</div>
			</div>
			<p className="whitespace-pre-wrap break-words text-sm text-foreground">
				{issue.content || t("issues.noDescription")}
			</p>
			<section className="space-y-2">
				<h3 className="text-sm font-medium text-foreground">{t("comments.title")}</h3>
				{comments === undefined && <p className="text-xs text-muted-foreground">{t("comments.loading")}</p>}
				{comments?.length === 0 && <p className="text-xs text-muted-foreground">{t("comments.none")}</p>}
				{comments?.map((c) => (
					<div key={c.id} className="rounded-md border border-border p-2">
						<p className="text-xs text-muted-foreground">{byLine(c.author, c.createdOn)}</p>
						<p className="whitespace-pre-wrap break-words text-sm text-foreground">{c.content}</p>
					</div>
				))}
			</section>
		</div>
	);
}
