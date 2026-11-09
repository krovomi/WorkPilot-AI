import { AlertTriangle, Check, FileSearch, Layers, RefreshCw, ShieldAlert, X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GuardrailAction, GuardrailEvent } from "../../../preload/api/modules/guardrails-api";
import { useGuardrailsStore } from "../../stores/guardrails-store";
import { CharterButton, Chip, Chips, Notice, Panel, Section, Stat, Stats, type Tone } from "../charter";
import { Input } from "../ui/input";

const OUTCOME_TONES: Record<string, Tone> = {
	warn: "amber",
	deny: "red",
	pending: "violet",
	approved: "green",
};

const ACTION_TONES: Record<GuardrailAction, Tone> = {
	allow: "green",
	warn: "amber",
	deny: "red",
	require_approval: "violet",
};

/** A rule that blocks this often in ten minutes is stopping the agents, not guiding them. */
const NOISY_THRESHOLD = 20;

function when(at: string, locale: string): string {
	const date = new Date(at);
	return Number.isNaN(date.getTime()) ? at : date.toLocaleString(locale);
}

function EventLine({ event }: { readonly event: GuardrailEvent }): React.ReactElement {
	const { t, i18n } = useTranslation("settings");
	const details = Object.values(event.details ?? {}).flat();
	return (
		<li className="flex flex-wrap items-baseline gap-2 text-xs">
			<Chip tone={OUTCOME_TONES[event.outcome] ?? "muted"}>{t(`guardrails.outcomes.${event.outcome}`, event.outcome)}</Chip>
			<span className="font-mono">{event.rules.join(", ")}</span>
			<span className="wp-meta break-all font-mono">
				{event.tool} · {event.target.summary}
			</span>
			{details.length > 0 && <span className="wp-meta">({details.join(", ")})</span>}
			<span className="wp-meta ml-auto">
				{event.task ? `${event.task} · ` : ""}
				{when(event.at, i18n.language)}
			</span>
		</li>
	);
}

/** What the backend reads, what is waiting for the person, and what the rules did. */
export function GuardrailsActivity({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t } = useTranslation("settings");
	const { policy, activity, diffCheck, checking, refreshInsights, answer, checkDiff } = useGuardrailsStore();
	const [ref, setRef] = useState("");
	const pending = activity?.pending ?? [];
	const counts = Object.entries(activity?.counts ?? {}).sort(
		(a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0),
	);

	return (
		<>
			<Section
				kicker={t("guardrails.kickers.policy")}
				title={t("guardrails.policyTitle")}
				description={t("guardrails.policyHint")}
				actions={
					<CharterButton variant="ghost" size="sm" icon={RefreshCw} onClick={() => void refreshInsights(projectPath)}>
						{t("guardrails.refresh")}
					</CharterButton>
				}
			>
				<Panel className="space-y-2" data-testid="guardrails-policy">
					{policy?.errors.length ? (
						<Notice tone="red" icon={ShieldAlert} role="alert">
							<p className="font-medium">{t("guardrails.invalidPolicy")}</p>
							<ul className="mt-1 list-disc pl-4 text-xs">
								{policy.errors.map((e) => (
									<li key={e} className="break-words font-mono">
										{e}
									</li>
								))}
							</ul>
						</Notice>
					) : null}
					{policy?.warnings.map((w) => (
						<Notice key={w} tone="amber" icon={AlertTriangle}>
							<span className="break-words font-mono text-xs">{w}</span>
						</Notice>
					))}
					{policy && policy.sources.length > 0 ? (
						<ul className="grid gap-1 text-xs">
							{policy.sources.map((s) => (
								<li key={s.path} className="flex flex-wrap items-baseline gap-2">
									<Chip tone="blue" dot={false}>
										<Layers className="h-3 w-3" aria-hidden="true" /> {t(`guardrails.layers.${s.layer}`)}
									</Chip>
									<span className="wp-meta break-all font-mono">{s.path}</span>
									<span className="wp-meta">{t("guardrails.layerRules", { count: s.rules })}</span>
								</li>
							))}
						</ul>
					) : (
						<p className="wp-muted text-sm">{t("guardrails.noLayers")}</p>
					)}
				</Panel>
			</Section>

			<Section kicker={t("guardrails.kickers.approvals")} title={t("guardrails.approvalsTitle", { count: pending.length })}>
				{pending.length === 0 ? (
					<p className="wp-muted text-sm">{t("guardrails.noPending")}</p>
				) : (
					<div className="grid gap-2" data-testid="guardrails-pending">
						{pending.map((request) => (
							<Panel key={request.id} rail tone="violet" className="space-y-2">
								<ul>
									<EventLine event={request} />
								</ul>
								{request.message && <p className="whitespace-pre-wrap text-xs">{request.message}</p>}
								<div className="flex gap-2">
									<CharterButton
										variant="primary"
										size="sm"
										icon={Check}
										onClick={() => void answer(projectPath, request.id, true)}
									>
										{t("guardrails.approveOnce")}
									</CharterButton>
									<CharterButton
										variant="ghost"
										size="sm"
										icon={X}
										onClick={() => void answer(projectPath, request.id, false)}
									>
										{t("guardrails.refuse")}
									</CharterButton>
								</div>
							</Panel>
						))}
					</div>
				)}
			</Section>

			<Section kicker={t("guardrails.kickers.activity")} title={t("guardrails.activityTitle")}>
				<Panel className="space-y-3" data-testid="guardrails-activity">
					{(activity?.blockedLast10Min ?? 0) >= NOISY_THRESHOLD && (
						<Notice tone="amber" icon={AlertTriangle}>
							{t("guardrails.noisy", { count: activity?.blockedLast10Min ?? 0 })}
						</Notice>
					)}
					{counts.length > 0 && (
						<Stats>
							{counts.slice(0, 6).map(([rule, perOutcome]) => (
								<Stat
									key={rule}
									label={<span className="font-mono">{rule}</span>}
									value={Object.values(perOutcome).reduce((x, y) => x + y, 0)}
									tone={perOutcome.deny || perOutcome.pending ? "red" : "amber"}
								/>
							))}
						</Stats>
					)}
					{activity && activity.events.length > 0 ? (
						<ul className="grid gap-1.5">
							{activity.events.slice(0, 20).map((event) => (
								<EventLine key={event.id} event={event} />
							))}
						</ul>
					) : (
						<p className="wp-muted text-sm">{t("guardrails.noActivity")}</p>
					)}
				</Panel>
			</Section>

			<Section
				kicker={t("guardrails.kickers.dryRun")}
				title={t("guardrails.dryRunTitle")}
				description={t("guardrails.dryRunHint")}
			>
				<Panel className="space-y-3">
					<div className="flex flex-wrap items-end gap-2">
						<div className="w-48">
							<label className="wp-kicker mb-1 block" htmlFor="guardrails-ref">
								{t("guardrails.compareWith")}
							</label>
							<Input
								id="guardrails-ref"
								className="h-8 font-mono text-xs"
								value={ref}
								onChange={(e) => setRef(e.target.value)}
								placeholder={t("guardrails.compareWithPlaceholder")}
							/>
						</div>
						<CharterButton
							variant="primary"
							icon={FileSearch}
							busy={checking}
							onClick={() => void checkDiff(projectPath, ref.trim() || undefined)}
						>
							{t("guardrails.checkChanges")}
						</CharterButton>
					</div>
					{diffCheck &&
						(diffCheck.files.length === 0 ? (
							<Notice tone="green" icon={Check} role="status">
								{t("guardrails.dryRunClean", { count: diffCheck.checked ?? 0, ref: diffCheck.ref })}
							</Notice>
						) : (
							<ul className="grid gap-1.5" data-testid="guardrails-dry-run">
								{diffCheck.files.map((file) => (
									<li key={file.path} className="flex flex-wrap items-baseline gap-2 text-xs">
										<Chip tone={ACTION_TONES[file.action]}>{t(`guardrails.actions.${file.action}`)}</Chip>
										<span className="break-all font-mono">{file.path}</span>
										<Chips>
											{file.triggered.map((id) => (
												<Chip key={id} tone="muted" dot={false}>
													<span className="font-mono">{id}</span>
												</Chip>
											))}
										</Chips>
										{Object.values(file.details).flat().length > 0 && (
											<span className="wp-meta">({Object.values(file.details).flat().join(", ")})</span>
										)}
									</li>
								))}
							</ul>
						))}
				</Panel>
			</Section>
		</>
	);
}
