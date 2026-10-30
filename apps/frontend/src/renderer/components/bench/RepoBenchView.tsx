/**
 * Repo bench: finished cards of this project, rebuilt from the commit before
 * them once per engine, and judged by the tests they landed with.
 *
 * The table says which provider × model × effort resolves this project's own
 * work, measured; Formula Lab and the model router read it too. The view
 * names a project, cards and engines; the main process does the rest
 * (main/ipc-handlers/bench-handlers.ts, docs/architecture/repo-bench.md).
 */

import { FlaskConical, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	BenchBuild,
	BenchCandidate,
	BenchCase,
	BenchManifest,
	BenchStatus,
	BenchTableRow,
} from "../../../shared/types";
import {
	defaultEngineProvider,
	type EngineTrio,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { useConfiguredProviders } from "../../hooks/useConfiguredProviders";
import { useBenchStore } from "../../stores/bench-store";
import { useSettingsStore } from "../../stores/settings-store";
import { EngineTrioPicker } from "../task-engine/EngineTrioPicker";
import { BenchRecommendationList } from "./BenchRecommendation";
import { dollars, minutes, percent } from "./format";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

export const MAX_CASES = 20;
export const MAX_ENGINES = 4;

interface Props {
	readonly projectId?: string;
}

function ResultsTable({ rows }: { rows: BenchTableRow[] }) {
	const { t } = useTranslation("bench");
	if (rows.length === 0) {
		return <p className="text-sm text-muted-foreground">{t("table.empty")}</p>;
	}
	return (
		<div className="overflow-x-auto rounded-lg border border-border">
			<table className="w-full text-sm">
				<thead className="bg-muted/50 text-left text-xs text-muted-foreground">
					<tr>
						<th className="px-3 py-2">{t("table.engine")}</th>
						<th className="px-3 py-2">{t("table.resolved")}</th>
						<th className="px-3 py-2">{t("table.f2p")}</th>
						<th className="px-3 py-2">{t("table.cost")}</th>
						<th className="px-3 py-2">{t("table.duration")}</th>
						<th className="px-3 py-2">{t("table.cards")}</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr
							key={`${row.provider}/${row.model}/${row.effort}`}
							className="border-t border-border"
						>
							<td className="px-3 py-2">
								<span className="font-medium">{row.model}</span>
								<span className="ml-2 text-xs text-muted-foreground">
									{row.provider} · {row.effort}
								</span>
							</td>
							<td className="px-3 py-2">
								<span className="font-semibold">{percent(row.rate)}</span>
								<span className="ml-2 text-xs text-muted-foreground">
									{t("table.ofJudged", { resolved: row.resolved, judged: row.judged })}
								</span>
							</td>
							<td className="px-3 py-2">{percent(row.f2pRate)}</td>
							<td className="px-3 py-2">{dollars(row.avgCostUsd)}</td>
							<td className="px-3 py-2">{minutes(row.avgDurationS)}</td>
							<td className="px-3 py-2">{row.cases}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Reason({ code, detail }: { code?: string; detail?: string }) {
	const { t } = useTranslation("bench");
	if (!code && !detail) return null;
	return (
		<span className="text-xs text-muted-foreground" title={detail}>
			{code ? t(`reasons.${code}`, { defaultValue: detail ?? code }) : detail}
		</span>
	);
}

function CaseLine({ benchCase }: { benchCase: BenchCase }) {
	const { t } = useTranslation("bench");
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<span className="font-mono text-xs">{benchCase.caseId}</span>
			<Badge variant="outline">{t(`caseStatus.${benchCase.status}`)}</Badge>
			{benchCase.status === "ready" && (
				<span className="text-xs text-muted-foreground">
					{t("run.tests", {
						f2p: benchCase.f2p?.length ?? 0,
						p2p: benchCase.p2p?.length ?? 0,
					})}
					{" · "}
					{(benchCase.suites ?? [])
						.map((s) => t(`suites.${s.kind}`, { defaultValue: s.kind }))
						.join(", ")}
				</span>
			)}
			<Reason code={benchCase.reasonCode} detail={benchCase.reason} />
		</div>
	);
}

function BuildCell({
	build,
	running,
}: {
	build: BenchBuild | undefined;
	running: boolean;
}) {
	const { t } = useTranslation("bench");
	if (!build) return <td className="px-2 py-1 text-muted-foreground">—</td>;
	let label: string;
	let tone = "text-muted-foreground";
	if (build.state === "judged") {
		label = build.resolved ? t("run.resolved") : t("run.notResolved");
		tone = build.resolved
			? "text-emerald-600 dark:text-emerald-400"
			: "text-red-600 dark:text-red-400";
	} else if (build.state === "skipped") {
		label = t("run.notCounted");
	} else {
		label = running ? t("run.building") : t("run.waiting");
	}
	return (
		<td className="px-2 py-1">
			<div className={`text-sm font-medium ${tone}`}>{label}</div>
			{build.state === "judged" && (
				<div className="text-[11px] text-muted-foreground">
					{dollars(build.costUsd)} · {minutes(build.durationS)}
				</div>
			)}
			{build.state === "skipped" && (
				<Reason code={build.reasonCode} detail={build.reason} />
			)}
		</td>
	);
}

function RunCard({
	run,
	status,
	onDiscard,
}: {
	run: BenchManifest & { stale?: boolean };
	status: BenchStatus;
	onDiscard: (runId: string) => void;
}) {
	const { t } = useTranslation("bench");
	const isActive = status.activeRunId === run.runId;
	const ready = run.cases.filter((c) => c.status === "ready");
	const canDiscard =
		run.stale ||
		(isActive && status.busy !== "discarding") ||
		(!isActive && (run.phase === "running" || run.phase === "calibrating"));
	return (
		<div className="space-y-3 rounded-lg border border-border p-4">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-xs">{run.runId}</span>
				<Badge variant="secondary">{t(`phase.${run.phase}`)}</Badge>
				{run.stale && <Badge variant="destructive">{t("run.stale")}</Badge>}
				{isActive && status.busy === "preparing" && (
					<span className="flex items-center gap-1 text-xs text-muted-foreground">
						<Loader2 className="h-3 w-3 animate-spin" />
						{t("run.preparing")}
					</span>
				)}
				{isActive && run.phase === "running" && (
					<span className="text-xs text-muted-foreground">
						{t("run.progress", {
							running: status.running.length,
							queued: status.queued,
						})}
					</span>
				)}
				{canDiscard && (
					<Button
						size="sm"
						variant="ghost"
						className="ml-auto"
						onClick={() => onDiscard(run.runId)}
					>
						<Trash2 className="mr-1 h-3.5 w-3.5" />
						{t("run.discard")}
					</Button>
				)}
			</div>
			<div className="space-y-1">
				{run.cases.map((c) => (
					<CaseLine key={c.caseId} benchCase={c} />
				))}
			</div>
			{ready.length > 0 && run.builds.length > 0 && (
				<div className="overflow-x-auto">
					<table className="w-full text-left">
						<thead className="text-xs text-muted-foreground">
							<tr>
								<th className="px-2 py-1">{t("run.card")}</th>
								{run.engines.map((e) => (
									<th key={e.id} className="px-2 py-1">
										{e.model}
										<span className="ml-1 text-[11px]">
											{e.provider} · {e.effort}
										</span>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{ready.map((c) => (
								<tr key={c.caseId} className="border-t border-border">
									<td className="px-2 py-1 font-mono text-xs">{c.caseId}</td>
									{run.engines.map((e) => {
										const build = run.builds.find(
											(b) => b.caseId === c.caseId && b.engineId === e.id,
										);
										return (
											<BuildCell
												key={e.id}
												build={build}
												running={
													!!build && isActive && status.running.includes(build.taskId)
												}
											/>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

export function RepoBenchView({ projectId }: Props) {
	const { t } = useTranslation(["bench", "common"]);
	const settings = useSettingsStore((s) => s.settings);
	const { providers } = useConfiguredProviders();
	const status = useBenchStore((s) =>
		projectId ? (s.statusByProject[projectId] ?? null) : null,
	);
	const storeStatus = useBenchStore((s) => s.setStatus);
	const setStatus = useCallback(
		(next: BenchStatus) => {
			if (projectId) storeStatus(projectId, next);
		},
		[projectId, storeStatus],
	);
	const [candidates, setCandidates] = useState<BenchCandidate[] | null>(null);
	const [loadingCandidates, setLoadingCandidates] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [commits, setCommits] = useState<Record<string, string>>({});
	const [engines, setEngines] = useState<EngineTrio[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	const seedTrio = useCallback(
		(): EngineTrio => seedEngine(settings, defaultEngineProvider(settings)).coding,
		[settings],
	);

	useEffect(() => {
		if (engines.length === 0) setEngines([seedTrio()]);
	}, [engines.length, seedTrio]);

	// Events arrive through the store (setupBenchListeners); this only fills
	// it for a project whose run has not sent one since the window opened.
	useEffect(() => {
		if (!projectId) return;
		window.electronAPI.getBenchStatus(projectId).then((result) => {
			if (result.success && result.data) setStatus(result.data);
		});
	}, [projectId, setStatus]);

	const loadCandidates = useCallback(async () => {
		if (!projectId) return;
		setLoadingCandidates(true);
		setError(null);
		const result = await window.electronAPI.getBenchCandidates(projectId);
		setLoadingCandidates(false);
		if (result.success && result.data) {
			setCandidates(result.data);
			setSelected((current) =>
				current.filter((id) => result.data?.some((c) => c.specId === id)),
			);
		} else {
			setError(result.error ?? t("bench:errors.candidates"));
		}
	}, [projectId, t]);

	useEffect(() => {
		void loadCandidates();
	}, [loadCandidates]);

	const selectable = useCallback(
		(candidate: BenchCandidate) =>
			candidate.case.status === "candidate" ||
			(candidate.case.reasonCode === "no-target" &&
				/^[0-9a-fA-F]{7,64}$/.test((commits[candidate.specId] ?? "").trim())),
		[commits],
	);

	const toggle = (specId: string, on: boolean) => {
		setSelected((current) =>
			on
				? current.includes(specId) || current.length >= MAX_CASES
					? current
					: [...current, specId]
				: current.filter((id) => id !== specId),
		);
	};

	const builds = selected.length * engines.length;
	const busy = !!status?.activeRunId;

	const start = async () => {
		if (!projectId || selected.length === 0 || engines.length === 0) return;
		setStarting(true);
		setError(null);
		const given = Object.fromEntries(
			selected
				.filter((id) => (commits[id] ?? "").trim())
				.map((id) => [id, commits[id].trim()]),
		);
		const result = await window.electronAPI.startBench(
			projectId,
			selected,
			engines.map((e) => ({ provider: e.provider, model: e.model, effort: e.effort })),
			given,
		);
		setStarting(false);
		if (result.success && result.data) {
			setStatus(result.data);
			setSelected([]);
		} else {
			setError(result.error ?? t("bench:errors.start"));
		}
	};

	const discard = async (runId: string) => {
		if (!projectId) return;
		const result = await window.electronAPI.discardBench(projectId, runId);
		if (result.success && result.data) setStatus(result.data);
		else setError(result.error ?? t("bench:errors.discard"));
	};

	const runs = useMemo(() => status?.runs ?? [], [status]);

	if (!projectId) {
		return (
			<div className="p-6 text-sm text-muted-foreground">{t("bench:noProject")}</div>
		);
	}

	return (
		<div className="mx-auto max-w-6xl space-y-6 p-6">
			<header className="space-y-1">
				<h1 className="flex items-center gap-2 text-xl font-semibold">
					<FlaskConical className="h-5 w-5" />
					{t("bench:title")}
				</h1>
				<p className="text-sm text-muted-foreground">{t("bench:description")}</p>
			</header>

			{error && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}
			{status?.error && (
				<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
					{status.error}
				</div>
			)}

			<section className="space-y-2">
				<h2 className="text-sm font-semibold">{t("bench:table.title")}</h2>
				<ResultsTable rows={status?.table ?? []} />
				<p className="text-xs text-muted-foreground">{t("bench:table.readers")}</p>
			</section>

			<section className="space-y-2">
				<h2 className="text-sm font-semibold">{t("bench:recommend.title")}</h2>
				<BenchRecommendationList recommendations={status?.recommendations ?? {}} />
				<p className="text-xs text-muted-foreground">{t("bench:recommend.rule")}</p>
			</section>

			<section className="space-y-3 rounded-lg border border-border p-4">
				<div className="flex items-center gap-2">
					<h2 className="text-sm font-semibold">{t("bench:new.title")}</h2>
					<Button
						size="sm"
						variant="ghost"
						className="ml-auto"
						onClick={() => void loadCandidates()}
						disabled={loadingCandidates}
					>
						<RefreshCw
							className={`mr-1 h-3.5 w-3.5 ${loadingCandidates ? "animate-spin" : ""}`}
						/>
						{t("bench:new.refresh")}
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					{t("bench:new.cardsHelp", { max: MAX_CASES })}
				</p>
				<div className="max-h-72 space-y-1 overflow-y-auto">
					{candidates === null && loadingCandidates && (
						<p className="text-sm text-muted-foreground">{t("bench:new.loading")}</p>
					)}
					{candidates?.length === 0 && (
						<p className="text-sm text-muted-foreground">{t("bench:new.none")}</p>
					)}
					{candidates?.map((candidate) => {
						const enabled = selectable(candidate);
						return (
							<div
								key={candidate.specId}
								className="flex flex-wrap items-center gap-2 rounded px-2 py-1 hover:bg-muted/40"
							>
								<Checkbox
									id={`bench-card-${candidate.specId}`}
									checked={selected.includes(candidate.specId)}
									disabled={!enabled || busy}
									onCheckedChange={(value) => toggle(candidate.specId, value === true)}
								/>
								<label
									htmlFor={`bench-card-${candidate.specId}`}
									className="min-w-0 flex-1 truncate text-sm"
								>
									{candidate.title}
								</label>
								{candidate.case.status === "candidate" ? (
									<span className="text-xs text-muted-foreground">
										{t("bench:new.found", {
											tests: candidate.case.runnable?.length ?? 0,
											source: t(`bench:source.${candidate.case.source ?? "merge"}`),
										})}
									</span>
								) : (
									<Reason
										code={candidate.case.reasonCode}
										detail={candidate.case.reason}
									/>
								)}
								{candidate.case.reasonCode === "no-target" && (
									<Input
										className="h-7 w-44 font-mono text-xs"
										placeholder={t("bench:new.commitPlaceholder")}
										aria-label={t("bench:new.commitPlaceholder")}
										value={commits[candidate.specId] ?? ""}
										onChange={(event) =>
											setCommits((current) => ({
												...current,
												[candidate.specId]: event.target.value,
											}))
										}
									/>
								)}
							</div>
						);
					})}
				</div>

				<div className="space-y-2">
					<h3 className="text-xs font-semibold text-muted-foreground">
						{t("bench:new.engines", { max: MAX_ENGINES })}
					</h3>
					{engines.map((engine, index) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: engines are edited in place
							key={index}
							className="flex items-end gap-2"
						>
							<EngineTrioPicker
								className="flex-1"
								idPrefix={`bench-engine-${index}`}
								value={engine}
								providers={providers}
								disabled={busy}
								onChange={(trio) =>
									setEngines((current) =>
										current.map((e, i) => (i === index ? trio : e)),
									)
								}
							/>
							{engines.length > 1 && (
								<Button
									size="icon"
									variant="ghost"
									aria-label={t("bench:new.removeEngine")}
									onClick={() =>
										setEngines((current) => current.filter((_, i) => i !== index))
									}
								>
									<X className="h-4 w-4" />
								</Button>
							)}
						</div>
					))}
					{engines.length < MAX_ENGINES && (
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => setEngines((current) => [...current, seedTrio()])}
						>
							<Plus className="mr-1 h-3.5 w-3.5" />
							{t("bench:new.addEngine")}
						</Button>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
					<span className="text-xs text-muted-foreground">
						{t("bench:new.summary", {
							cards: selected.length,
							engines: engines.length,
							builds,
						})}
					</span>
					<Button
						className="ml-auto"
						disabled={busy || starting || selected.length === 0 || engines.length === 0}
						onClick={() => void start()}
					>
						{starting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
						{t("bench:new.start")}
					</Button>
				</div>
				{busy && <p className="text-xs text-muted-foreground">{t("bench:new.oneAtATime")}</p>}
				<p className="text-xs text-muted-foreground">{t("bench:new.costWarning")}</p>
			</section>

			{runs.length > 0 && (
				<section className="space-y-3">
					<h2 className="text-sm font-semibold">{t("bench:run.title")}</h2>
					{runs.map((run) =>
						status ? (
							<RunCard key={run.runId} run={run} status={status} onDiscard={discard} />
						) : null,
					)}
				</section>
			)}
		</div>
	);
}
