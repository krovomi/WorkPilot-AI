import { AlertTriangle, ChevronDown, ChevronRight, History, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSession } from "@shared/types";
import { useTranslation } from "react-i18next";
import { useServerProjectId } from "../hooks/useServerProjectId";
import { formatAppDateTime } from "@/lib/date-format";
import {
	CharterButton,
	Chip,
	EmptyStage,
	ModuleHeader,
	ModuleStage,
	Notice,
	Page,
	Panel,
	ScanLine,
	Section,
	Stat,
	Stats,
	Tabs,
	type Tone,
} from "./charter";

type SessionEntry = WorkspaceSession;

interface SessionHistoryProps {
	readonly projectId: string;
}

type Filter = "all" | "completed" | "failed" | "running";

const FILTERS: readonly Filter[] = ["all", "completed", "failed", "running"];

/** The status group a raw status belongs to; "other" for paused or unknown. */
function statusGroup(status: string): Exclude<Filter, "all"> | "other" {
	const s = status.toLowerCase();
	if (s === "completed" || s === "success") return "completed";
	if (s === "failed" || s === "error") return "failed";
	if (s === "running" || s === "in_progress") return "running";
	return "other";
}

const GROUP_TONE: Record<ReturnType<typeof statusGroup>, Tone> = {
	completed: "green",
	failed: "red",
	running: "blue",
	other: "muted",
};

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
}

function formatDateTime(iso: string): string {
	try {
		return formatAppDateTime(new Date(iso), {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return iso;
	}
}

function SessionCard({ session }: { readonly session: SessionEntry }) {
	const { t } = useTranslation("sessionHistory");
	const [expanded, setExpanded] = useState(false);
	const tone = GROUP_TONE[statusGroup(session.status)];
	const Chevron = expanded ? ChevronDown : ChevronRight;

	return (
		<Panel rail tone={tone}>
			<button
				type="button"
				className="flex w-full items-start gap-2 text-left"
				onClick={() => setExpanded(!expanded)}
				aria-expanded={expanded}
			>
				<Chevron className="wp-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="wp-title truncate text-sm">
							{session.task_title || session.task_id || session.session_id}
						</span>
						<Chip tone={tone}>{session.status}</Chip>
						{session.phase && session.phase !== session.task_title && (
							<Chip tone="muted" dot={false}>
								{session.phase}
							</Chip>
						)}
					</div>
					<p className="wp-meta mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
						<span>{formatDateTime(session.started_at)}</span>
						{session.started_by && <span>{t("server.startedBy", { name: session.started_by })}</span>}
						{session.duration_seconds !== undefined && <span>{formatDuration(session.duration_seconds)}</span>}
						{session.tokens_used !== undefined && (
							<span>
								{t("tokensCount", {
									count: session.tokens_used,
									formatted: session.tokens_used.toLocaleString(),
								})}
							</span>
						)}
						{session.files_changed !== undefined && (
							<span>{t("filesCount", { count: session.files_changed })}</span>
						)}
						{session.cost !== undefined && <span>{t("costValue", { value: session.cost.toFixed(4) })}</span>}
					</p>
				</div>
			</button>

			{expanded && (
				<div className="mt-3 space-y-3 pl-6">
					{session.error && (
						<Notice tone="red" icon={AlertTriangle}>
							{session.error}
						</Notice>
					)}
					{session.phases && session.phases.length > 0 && (
						<div className="space-y-1.5">
							<span className="wp-kicker block">{t("phases")}</span>
							{session.phases.map((phase) => (
								<div
									key={`${session.session_id}-${phase.name}`}
									className="flex items-center gap-2 text-xs"
								>
									<Chip tone={GROUP_TONE[statusGroup(phase.status)]}>{phase.name}</Chip>
									<span className="flex-1" />
									{phase.duration_seconds !== undefined && (
										<span className="wp-meta">{formatDuration(phase.duration_seconds)}</span>
									)}
									{phase.tokens !== undefined && (
										<span className="wp-meta font-mono">
											{t("tokensCount", {
												count: phase.tokens,
												formatted: phase.tokens.toLocaleString(),
											})}
										</span>
									)}
								</div>
							))}
						</div>
					)}
					<p className="wp-meta flex flex-wrap gap-x-4">
						<span>
							{t("session.session")}: <span className="wp-title font-mono">{session.session_id}</span>
						</span>
						{session.ended_at && (
							<span>
								{t("session.ended")}: {formatDateTime(session.ended_at)}
							</span>
						)}
					</p>
				</div>
			)}
		</Panel>
	);
}

/** Agent sessions of the project: replay store locally, runs and jobs on a server. */
export function SessionHistory({ projectId }: SessionHistoryProps) {
	const { t } = useTranslation(["sessionHistory", "navigation"]);
	const [sessions, setSessions] = useState<SessionEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<Filter>("all");
	const serverProjectId = useServerProjectId({ id: projectId });

	const fetchSessions = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			setError(null);
			try {
				// A server project's sessions are its runs and jobs on the server.
				if (serverProjectId) {
					const result = await globalThis.electronAPI.getServerSessions(serverProjectId);
					if (signal?.aborted) return;
					if (result.success) setSessions(result.data ?? []);
					else setError(result.error || t("sessionHistory:errors.loadFailed"));
					return;
				}
				// Main reads the local backend (replay-handlers.ts): the renderer
				// has no backend URL of its own.
				const data = await globalThis.electronAPI.listSessionHistory<{
					sessions?: SessionEntry[];
				}>(projectId);
				if (signal?.aborted) return;
				if (data.success) setSessions(data.sessions || []);
				else if (data.unreachable) setError(t("sessionHistory:errors.backendUnreachable"));
				else setError(data.error || t("sessionHistory:errors.loadFailed"));
			} catch (e) {
				if ((e as { name?: string })?.name === "AbortError") return;
				setError(t("sessionHistory:errors.backendUnreachable"));
			} finally {
				setLoading(false);
			}
		},
		[projectId, serverProjectId, t],
	);

	useEffect(() => {
		const controller = new AbortController();
		fetchSessions(controller.signal);
		return () => controller.abort();
	}, [fetchSessions]);

	const counts: Record<Filter, number> = { all: sessions.length, completed: 0, failed: 0, running: 0 };
	for (const s of sessions) {
		const group = statusGroup(s.status);
		if (group !== "other") counts[group] += 1;
	}
	const totalTokens = sessions.reduce((sum, s) => sum + (s.tokens_used || 0), 0);
	const filtered = filter === "all" ? sessions : sessions.filter((s) => statusGroup(s.status) === filter);

	return (
		<ModuleStage scroll="page" data-testid="session-history-view">
			<ModuleHeader
				kicker={t("navigation:groups.workspace")}
				title={t("sessionHistory:title")}
				description={serverProjectId ? t("sessionHistory:serverSubtitle") : t("sessionHistory:subtitle")}
				icon={History}
				tone="blue"
				actions={
					<CharterButton icon={RefreshCw} busy={loading} onClick={() => void fetchSessions()}>
						{t("sessionHistory:refresh")}
					</CharterButton>
				}
			/>
			<Page className="space-y-4">
				<Stats>
					<Stat label={t("sessionHistory:stats.total")} value={counts.all} />
					<Stat label={t("sessionHistory:stats.completed")} value={counts.completed} tone="green" />
					<Stat label={t("sessionHistory:stats.failed")} value={counts.failed} tone="red" />
					<Stat label={t("sessionHistory:stats.tokens")} value={totalTokens.toLocaleString()} tone="violet" />
				</Stats>

				{error && (
					<Notice tone="red" icon={AlertTriangle} role="alert">
						{error}
					</Notice>
				)}

				<Section
					kicker={t("sessionHistory:kickers.list")}
					title={t("sessionHistory:listTitle")}
					actions={
						<Tabs
							label={t("sessionHistory:listTitle")}
							value={filter}
							onChange={setFilter}
							tabs={FILTERS.map((f) => ({ id: f, label: t(`sessionHistory:filters.${f}`), count: counts[f] }))}
						/>
					}
				>
					{loading ? (
						<ScanLine label={t("sessionHistory:loading")} />
					) : filtered.length === 0 ? (
						<EmptyStage icon={History} tone="blue" title={t("sessionHistory:noSessions")}>
							{t("sessionHistory:noSessionsHint")}
						</EmptyStage>
					) : (
						<div className="space-y-2">
							{filtered.map((session) => (
								<SessionCard key={session.session_id} session={session} />
							))}
						</div>
					)}
				</Section>
			</Page>
		</ModuleStage>
	);
}
