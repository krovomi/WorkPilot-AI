import { Clock, Download, FileLock2, Gauge, RefreshCw, ShieldAlert } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	AuditExportFormat,
	GovernanceReport,
	PolicyAuditEvent,
	PolicyDecision,
} from "../../../shared/types/governance";
import { formatAppDateTime } from "../../lib/date-format";
import { CharterButton, Chip, Chips, Notice, Panel, Section, type Tone } from "../charter";

const DECISION_TONES: Record<PolicyDecision, Tone> = {
	deny: "red",
	review: "violet",
	approved: "green",
	warn: "amber",
	outside_hours: "blue",
	budget_exceeded: "amber",
	invalid_policy: "red",
};

function DecisionLine({ event }: { readonly event: PolicyAuditEvent }): React.ReactElement {
	const { t } = useTranslation("settings");
	return (
		<li className="flex flex-wrap items-baseline gap-2 text-xs">
			<Chip tone={DECISION_TONES[event.decision] ?? "muted"}>{t(`governance.decisions.${event.decision}`)}</Chip>
			{event.rules.length > 0 && <span className="font-mono">{event.rules.join(", ")}</span>}
			{event.target && (
				<span className="wp-meta break-all font-mono">
					{event.tool ? `${event.tool} · ` : ""}
					{event.target}
				</span>
			)}
			<span className="wp-meta ml-auto">
				{[event.task, event.provider, event.model, event.user].filter(Boolean).join(" · ")}
				{" · "}
				{formatAppDateTime(event.at)}
			</span>
		</li>
	);
}

function GlobList({ globs, empty }: { readonly globs: readonly string[]; readonly empty: string }) {
	if (globs.length === 0) return <p className="wp-muted text-xs">{empty}</p>;
	return (
		<Chips>
			{globs.map((glob) => (
				<Chip key={glob} tone="muted" dot={false}>
					<code>{glob}</code>
				</Chip>
			))}
		</Chips>
	);
}

/**
 * The governance sections of `workpilot.policy.yaml`, read only: the hours, the
 * files and the token budget every agent is held to, why the file is refused
 * when it is, the policy's last decisions, and the export of its audit trail.
 */
export function GovernancePolicyPanel({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t, i18n } = useTranslation("settings");
	const [report, setReport] = useState<GovernanceReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [exported, setExported] = useState<{ count: number; path: string } | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setReport(await window.electronAPI.getGovernanceReport(projectPath));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [projectPath]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const exportAs = async (format: AuditExportFormat) => {
		setExportError(null);
		try {
			const result = await window.electronAPI.exportPolicyAudit(projectPath, format);
			setExported(result ? { count: result.count, path: result.filePath } : null);
		} catch (err) {
			setExported(null);
			setExportError(err instanceof Error ? err.message : String(err));
		}
	};

	const governance = report?.governance ?? null;
	const schedule = governance?.schedule ?? null;
	const budget = governance?.budget ?? null;
	const events = report?.events ?? [];

	return (
		<Section
			kicker={t("governance.kicker")}
			title={t("governance.title")}
			description={t("governance.hint")}
			actions={
				<CharterButton variant="ghost" size="sm" icon={RefreshCw} busy={loading} onClick={() => void refresh()}>
					{t("governance.refresh")}
				</CharterButton>
			}
		>
			<Panel className="space-y-3" data-testid="governance-panel">
				{error && (
					<Notice tone="red" icon={ShieldAlert} role="alert">
						{t("governance.loadFailed", { error })}
					</Notice>
				)}
				{report && report.errors.length > 0 && (
					<Notice tone="red" icon={ShieldAlert} role="alert">
						<p className="font-medium">{t("governance.invalid")}</p>
						<ul className="mt-1 list-disc pl-4 text-xs">
							{report.errors.map((e) => (
								<li key={e} className="break-words font-mono">
									{e}
								</li>
							))}
						</ul>
					</Notice>
				)}
				{report && !governance && report.errors.length === 0 && (
					<p className="wp-muted text-sm">{t("governance.none")}</p>
				)}
				{governance && (
					<div className="grid gap-3 md:grid-cols-3">
						<div className="space-y-1" data-testid="governance-schedule">
							<p className="wp-kicker flex items-center gap-1">
								<Clock className="h-3 w-3" aria-hidden="true" /> {t("governance.scheduleTitle")}
							</p>
							{schedule ? (
								<>
									<Chip tone={schedule.openNow ? "green" : "red"}>
										{t(schedule.openNow ? "governance.openNow" : "governance.closedNow")}
									</Chip>
									<p className="text-xs">
										{t("governance.scheduleLine", {
											hours: schedule.allowedHours.join(", "),
											timezone: schedule.timezone,
											days: schedule.days.join(", "),
										})}
									</p>
								</>
							) : (
								<p className="wp-muted text-xs">{t("governance.noSchedule")}</p>
							)}
						</div>
						<div className="space-y-1" data-testid="governance-files">
							<p className="wp-kicker flex items-center gap-1">
								<FileLock2 className="h-3 w-3" aria-hidden="true" /> {t("governance.filesTitle")}
							</p>
							<p className="text-xs font-medium">{t("governance.forbidden")}</p>
							<GlobList globs={governance.files.forbidden} empty={t("governance.noFiles")} />
							<p className="text-xs font-medium">{t("governance.requiresReview")}</p>
							<GlobList globs={governance.files.requiresReview} empty={t("governance.noFiles")} />
						</div>
						<div className="space-y-1" data-testid="governance-budget">
							<p className="wp-kicker flex items-center gap-1">
								<Gauge className="h-3 w-3" aria-hidden="true" /> {t("governance.budgetTitle")}
							</p>
							<p className="text-xs">
								{budget
									? t("governance.budgetLine", {
											spent: (report?.tokensLastHour ?? 0).toLocaleString(i18n.language),
											limit: budget.maxTokensPerHour.toLocaleString(i18n.language),
										})
									: t("governance.noBudget")}
							</p>
						</div>
					</div>
				)}
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<p className="wp-kicker mr-auto">{t("governance.decisionsTitle")}</p>
						<CharterButton variant="ghost" size="sm" icon={Download} onClick={() => void exportAs("csv")}>
							{t("governance.exportCsv")}
						</CharterButton>
						<CharterButton variant="ghost" size="sm" icon={Download} onClick={() => void exportAs("json")}>
							{t("governance.exportJson")}
						</CharterButton>
					</div>
					{exported && (
						<Notice tone="green" role="status">
							{t("governance.exported", { count: exported.count, path: exported.path })}
						</Notice>
					)}
					{exportError && (
						<Notice tone="red" role="alert">
							{t("governance.exportFailed", { error: exportError })}
						</Notice>
					)}
					{events.length > 0 ? (
						<ul className="grid gap-1.5" data-testid="governance-decisions">
							{events.slice(0, 20).map((event) => (
								<DecisionLine key={event.id} event={event} />
							))}
						</ul>
					) : (
						<p className="wp-muted text-sm">{t("governance.noDecisions")}</p>
					)}
				</div>
			</Panel>
		</Section>
	);
}
