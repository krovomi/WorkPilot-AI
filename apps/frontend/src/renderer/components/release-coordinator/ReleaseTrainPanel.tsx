import { AlertTriangle, CalendarClock, FileText, Flag, Play, ShieldCheck, TrainFront, Zap } from "lucide-react";
import type React from "react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TrainServiceView, TrainView } from "../../../shared/types/release-train";
import { formatAppDateTime } from "../../lib/date-format";
import { useReleaseTrainStore } from "../../stores/release-train-store";
import { CharterButton, Chip, Chips, EmptyStage, Notice, Panel, ScanLine, Section, Stat, Stats, type Tone } from "../charter";
import { NativeSelect } from "../ui/native-select";
import { RUN_TONES } from "./tones";
import { TrainRunCard } from "./TrainRunCard";

const CRITICALITY_TONES: Record<TrainServiceView["criticality"], Tone> = {
	high: "red",
	normal: "blue",
	low: "muted",
};

const EXAMPLE = `services:
  - name: backend
    deploy:   {command: [./deploy.sh, "{environment}", "{version}"]}
    rollback: {command: [./rollback.sh, "{environment}", "{previous_version}"]}
    health:   {url: "https://api.example.com/health"}
  - name: frontend
    depends_on: [backend]
    deploy:   {command: [gh, workflow, run, deploy.yml, -f, "env={environment}"]}
    smoke:    {command: [gh, run, watch, --exit-status]}`;

/** The release train (#362): the approved train file ships the services, wave after wave. */
export function ReleaseTrainPanel({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	const loading = useReleaseTrainStore((s) => s.loading);
	const busy = useReleaseTrainStore((s) => s.busy);
	const state = useReleaseTrainStore((s) => s.state);
	const run = useReleaseTrainStore((s) => s.run);
	const live = useReleaseTrainStore((s) => s.live);
	const error = useReleaseTrainStore((s) => s.error);
	const { load, approve, onEvent } = useReleaseTrainStore.getState();

	useEffect(() => {
		void load(projectPath);
	}, [load, projectPath]);
	useEffect(() => globalThis.electronAPI.onReleaseTrainEvent(onEvent), [onEvent]);

	const view = state?.view;
	return (
		<Section kicker={t("train.kicker")} title={t("train.title")} tone="violet">
			<p className="wp-meta mb-3">{t("train.hint")}</p>
			{loading && !state && <ScanLine label={t("train.loading")} />}
			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{error === "changed" ? t("train.changedWhileApproving") : t("train.failed", { error })}
				</Notice>
			)}
			{state && !state.present && (
				<EmptyStage icon={TrainFront} title={t("train.noFileTitle")} tone="violet">
					<p>{t("train.noFile")}</p>
					<pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-left font-mono text-xs">{EXAMPLE}</pre>
				</EmptyStage>
			)}
			{state?.present && state.error && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{t("train.invalid", { error: state.error })}
				</Notice>
			)}
			{view && !state?.approved && (
				<Panel rail tone="amber" className="mb-3">
					<p className="wp-title text-sm">{t("approval.title")}</p>
					<p className="wp-meta mt-1">{t("approval.hint", { path: view.path, sha: view.sha256.slice(0, 12) })}</p>
					<Commands view={view} />
					<CharterButton className="mt-2" variant="primary" icon={ShieldCheck} onClick={approve} disabled={busy}>
						{t("approval.approve")}
					</CharterButton>
				</Panel>
			)}
			{view && (
				<>
					<Problems view={view} />
					<Waves view={view} />
					{state?.approved && <StartBar view={view} disabled={busy || isOpen(run?.status)} />}
					{busy && (
						<ScanLine
							label={
								live?.service
									? t("train.liveStep", { service: live.service, step: t(`steps.${live.step}`, { defaultValue: live.step }) })
									: t("train.working")
							}
						/>
					)}
					{run && <TrainRunCard run={run} />}
					<RecentRuns view={view} />
					<CalendarList view={view} />
					<NotesAndMetrics />
				</>
			)}
		</Section>
	);
}

const isOpen = (status: string | undefined) =>
	status === "running" || status === "waiting" || status === "blocked";

function Commands({ view }: { readonly view: TrainView }): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	return (
		<ul className="mt-2 space-y-1 text-xs">
			{view.services.map((service) =>
				Object.entries(service.steps).map(([kind, step]) => (
					<li key={`${service.name}-${kind}`} className="font-mono">
						<span className="wp-kicker mr-2">
							{service.name} · {t(`steps.${kind}`, { defaultValue: kind })}
						</span>
						{step?.command.length ? step.command.join(" ") : step?.url}
					</li>
				)),
			)}
			{view.variables.length > 0 && (
				<li className="wp-meta">{t("approval.variables", { names: view.variables.join(", ") })}</li>
			)}
		</ul>
	);
}

function Problems({ view }: { readonly view: TrainView }): React.ReactElement | null {
	const { t } = useTranslation("releaseCoordinator");
	if (view.problems.length === 0) return null;
	return (
		<Notice tone="amber" icon={AlertTriangle}>
			<ul className="space-y-1">
				{view.problems.map((problem) => (
					<li key={JSON.stringify(problem)}>
						{problem.code === "cycle"
							? t("problems.cycle", { services: problem.services.join(" → "), from: problem.cut[0], to: problem.cut[1] })
							: problem.code === "unknown_dependency"
								? t("problems.unknownDependency", { service: problem.service, dependency: problem.dependency })
								: t("problems.noDeploy", { service: problem.service })}
					</li>
				))}
			</ul>
		</Notice>
	);
}

function Waves({ view }: { readonly view: TrainView }): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	const byName = new Map(view.services.map((s) => [s.name, s]));
	return (
		<div className="mb-3 grid gap-2">
			{view.order.waves.map((wave, index) => (
				<Panel key={wave.join(",")} rail tone="violet">
					<div className="wp-kicker mb-1">{t("train.wave", { number: index + 1 })}</div>
					<Chips>
						{wave.map((name) => {
							const service = byName.get(name);
							return (
								<Chip key={name} tone={service?.external ? "amber" : CRITICALITY_TONES[service?.criticality ?? "normal"]}>
									{name}
									{service?.external ? ` · ${t("train.external")}` : ""}
								</Chip>
							);
						})}
					</Chips>
				</Panel>
			))}
			{view.flags.length > 0 && (
				<p className="wp-meta flex items-center gap-1.5">
					<Flag className="h-3.5 w-3.5" aria-hidden />
					{view.flags.map((f) => t("train.flagLine", { key: f.key, provider: f.provider, services: f.services.join(", ") })).join(" · ")}
				</p>
			)}
		</div>
	);
}

function StartBar({ view, disabled }: { readonly view: TrainView; readonly disabled: boolean }): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	const envId = useId();
	const serviceId = useId();
	const [environment, setEnvironment] = useState(view.environments[0]?.name ?? "");
	const [hotfix, setHotfix] = useState(view.services.find((s) => !s.external)?.name ?? "");
	const { start } = useReleaseTrainStore.getState();
	const production = view.environments.find((e) => e.name === environment)?.production;
	return (
		<Panel className="mb-3">
			<div className="flex flex-wrap items-center gap-2">
				<label htmlFor={envId} className="wp-kicker">
					{t("start.environment")}
				</label>
				<NativeSelect id={envId} value={environment} onChange={(e) => setEnvironment(e.target.value)} disabled={disabled}>
					{view.environments.map((env) => (
						<option key={env.name} value={env.name}>
							{env.production ? t("start.production", { name: env.name }) : env.name}
						</option>
					))}
				</NativeSelect>
				<CharterButton
					variant="primary"
					icon={Play}
					onClick={() => start(environment)}
					disabled={disabled || !environment || view.order.cycle.length > 0}
				>
					{t("start.train")}
				</CharterButton>
				<span className="wp-meta mx-1">{t("start.or")}</span>
				<label htmlFor={serviceId} className="wp-kicker">
					{t("start.hotfix")}
				</label>
				<NativeSelect id={serviceId} value={hotfix} onChange={(e) => setHotfix(e.target.value)} disabled={disabled}>
					{view.services
						.filter((s) => !s.external)
						.map((s) => (
							<option key={s.name} value={s.name}>
								{s.name}
							</option>
						))}
				</NativeSelect>
				<CharterButton
					variant="ghost"
					icon={Zap}
					onClick={() => start(environment, { services: [hotfix], express: true })}
					disabled={disabled || !hotfix || !environment}
				>
					{t("start.express")}
				</CharterButton>
			</div>
			<p className="wp-meta mt-2">{production ? t("start.productionHint") : t("start.stagingHint")}</p>
		</Panel>
	);
}

function RecentRuns({ view }: { readonly view: TrainView }): React.ReactElement | null {
	const { t } = useTranslation("releaseCoordinator");
	const { openRun } = useReleaseTrainStore.getState();
	if (view.runs.length === 0) return null;
	return (
		<div className="mb-3">
			<div className="wp-kicker mb-1">{t("runs.title")}</div>
			<Chips>
				{view.runs.map((r) => (
					<Chip key={r.id} tone={RUN_TONES[r.status]} onClick={() => openRun(r.id)} title={r.id}>
						{t("runs.line", {
							environment: r.environment,
							status: t(`runStatuses.${r.status}`),
							date: formatAppDateTime(r.createdAt),
						})}
					</Chip>
				))}
			</Chips>
		</div>
	);
}

function CalendarList({ view }: { readonly view: TrainView }): React.ReactElement | null {
	const { t } = useTranslation("releaseCoordinator");
	if (view.calendar.slots.length === 0) return null;
	return (
		<div className="mb-3">
			<div className="wp-kicker mb-1 flex items-center gap-1.5">
				<CalendarClock className="h-3.5 w-3.5" aria-hidden />
				{t("calendar.title")}
			</div>
			<ul className="space-y-1 text-sm">
				{view.calendar.slots.map((slot) => (
					<li key={`${slot.service}-${slot.environment}-${slot.at}`} className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-xs">{formatAppDateTime(slot.at)}</span>
						<span>{t("calendar.slot", { service: slot.service, environment: slot.environment, minutes: slot.minutes })}</span>
						{slot.conflict && <Chip tone="red">{t("calendar.conflict")}</Chip>}
					</li>
				))}
			</ul>
		</div>
	);
}

function NotesAndMetrics(): React.ReactElement {
	const { t } = useTranslation("releaseCoordinator");
	const aiId = useId();
	const [ai, setAi] = useState(false);
	const busy = useReleaseTrainStore((s) => s.busy);
	const notes = useReleaseTrainStore((s) => s.notes);
	const months = useReleaseTrainStore((s) => s.months);
	const { loadNotes } = useReleaseTrainStore.getState();
	const month = months.at(-1);
	return (
		<>
			{month && (
				<Stats>
					<Stat label={t("metrics.trains")} value={month.trains} />
					<Stat label={t("metrics.multiService")} value={month.multiService} />
					<Stat label={t("metrics.meanMinutes")} value={month.meanMinutes ?? "—"} />
					<Stat label={t("metrics.blockedByGates")} value={month.blockedByGates} tone={month.blockedByGates ? "amber" : "muted"} />
					<Stat label={t("metrics.rollbacks")} value={`${month.rollbacksOk}/${month.rollbacks}`} tone="violet" />
				</Stats>
			)}
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<CharterButton variant="ghost" icon={FileText} onClick={() => loadNotes(ai)} disabled={busy}>
					{t("notes.make")}
				</CharterButton>
				<input id={aiId} type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} disabled={busy} />
				<label htmlFor={aiId} className="text-sm">
					{t("notes.ai")}
				</label>
			</div>
			{notes && (
				<Panel className="mt-2">
					<p className="wp-meta mb-1">{notes.by === "model" ? t("notes.byModel") : t("notes.byRules")}</p>
					<pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs">{notes.markdown}</pre>
				</Panel>
			)}
		</>
	);
}
