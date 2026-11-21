import { Check, Download, OctagonX, RefreshCw, ShieldAlert, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	AuditExportFormat,
	GovernanceRequest,
	ServerGovernanceReport,
	ServerStopScope,
} from "../../../shared/types/governance";
import { formatAppDateTime } from "../../lib/date-format";
import { CharterButton, Chip, Notice, Panel, Section } from "../charter";
import { DecisionList, MetricsChips, PolicySections } from "./governance-parts";

type Outcome = { tone: "green" | "red"; text: string } | null;

function RequestLine({
	request,
	canAnswer,
	busy,
	onAnswer,
}: {
	readonly request: GovernanceRequest;
	readonly canAnswer: boolean;
	readonly busy: boolean;
	readonly onAnswer: (approved: boolean) => void;
}): React.ReactElement {
	const { t } = useTranslation("settings");
	return (
		<li className="flex flex-wrap items-center gap-2 text-xs" data-testid="governance-request">
			<Chip tone="violet">{t("governance.decisions.review")}</Chip>
			<span className="font-mono">{request.rules.join(", ")}</span>
			{request.target && (
				<span className="wp-meta break-all font-mono">
					{request.tool ? `${request.tool} · ` : ""}
					{request.target}
				</span>
			)}
			<span className="wp-meta">
				{[request.task, formatAppDateTime(request.at)].filter(Boolean).join(" · ")}
			</span>
			{canAnswer && (
				<span className="ml-auto flex gap-1">
					<CharterButton variant="primary" size="sm" icon={Check} busy={busy} onClick={() => onAnswer(true)}>
						{t("governance.approve")}
					</CharterButton>
					<CharterButton variant="ghost" size="sm" icon={X} disabled={busy} onClick={() => onAnswer(false)}>
						{t("governance.refuse")}
					</CharterButton>
				</span>
			)}
		</li>
	);
}

/**
 * The governance of a server project (server mode): what its
 * `workpilot.policy.yaml` says, read by the server from its clone, the calls
 * its agents wait on, its last decisions and its kill switch. Every action
 * goes to the server, which checks the person's rights again; the buttons
 * only show what it says the person may do.
 */
export function ServerGovernancePanel({ projectId }: { readonly projectId: string }): React.ReactElement {
	const { t } = useTranslation("settings");
	const [report, setReport] = useState<ServerGovernanceReport | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [answering, setAnswering] = useState<string | null>(null);
	const [confirmAll, setConfirmAll] = useState(false);
	const [outcome, setOutcome] = useState<Outcome>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		const result = await window.electronAPI.getServerGovernance(projectId);
		if (result.success && result.data) {
			setReport(result.data);
			setError(null);
		} else {
			setError(result.error ?? "");
		}
		setLoading(false);
	}, [projectId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const answer = async (requestId: string, approved: boolean) => {
		setAnswering(requestId);
		const result = await window.electronAPI.answerServerGovernanceRequest(projectId, requestId, approved);
		setAnswering(null);
		setOutcome(
			result.success && result.data
				? { tone: "green", text: t(`governance.answered.${result.data.decision}`) }
				: { tone: "red", text: t("governance.answerFailed", { error: result.error ?? "" }) },
		);
		await refresh();
	};

	const stop = async (scope: ServerStopScope) => {
		setConfirmAll(false);
		const result = await window.electronAPI.stopServerProjectAgents(projectId, scope);
		setOutcome(
			result.success && result.data
				? {
						tone: "green",
						text: t("governance.stopped", { count: result.data.stoppedRuns + result.data.stoppedJobs }),
					}
				: { tone: "red", text: t("governance.stopFailed", { error: result.error ?? "" }) },
		);
		await refresh();
	};

	const exportAs = async (format: AuditExportFormat) => {
		const result = await window.electronAPI.exportServerPolicyAudit(projectId, format);
		if (!result.success) {
			setOutcome({ tone: "red", text: t("governance.exportFailed", { error: result.error ?? "" }) });
		} else if (result.data) {
			setOutcome({
				tone: "green",
				text: t("governance.exported", { count: result.data.count, path: result.data.filePath }),
			});
		}
	};

	const may = report?.may;
	return (
		<Section
			kicker={t("governance.kicker")}
			title={t("governance.serverTitle")}
			description={t("governance.serverHint")}
			actions={
				<CharterButton variant="ghost" size="sm" icon={RefreshCw} busy={loading} onClick={() => void refresh()}>
					{t("governance.refresh")}
				</CharterButton>
			}
		>
			<Panel className="space-y-3" data-testid="server-governance-panel">
				{error !== null && (
					<Notice tone="red" icon={ShieldAlert} role="alert">
						{t("governance.loadFailed", { error })}
					</Notice>
				)}
				{outcome && (
					<Notice tone={outcome.tone} role={outcome.tone === "red" ? "alert" : "status"}>
						{outcome.text}
					</Notice>
				)}
				{report && <PolicySections report={report} onServer />}
				{report && (
					<div className="flex flex-wrap items-center gap-2" data-testid="governance-agents">
						<p className="wp-kicker mr-auto">
							{t("governance.agentsLine", { mine: report.agents.mine, project: report.agents.project })}
						</p>
						{may?.stop && (
							<CharterButton variant="ghost" size="sm" icon={OctagonX} onClick={() => void stop("mine")}>
								{t("governance.stopMine")}
							</CharterButton>
						)}
						{may?.stopProject &&
							(confirmAll ? (
								<CharterButton variant="primary" size="sm" icon={OctagonX} onClick={() => void stop("project")}>
									{t("governance.stopProjectConfirm", { count: report.agents.project })}
								</CharterButton>
							) : (
								<CharterButton variant="ghost" size="sm" icon={OctagonX} onClick={() => setConfirmAll(true)}>
									{t("governance.stopProject")}
								</CharterButton>
							))}
					</div>
				)}
				{report && report.pending.length > 0 && (
					<div className="space-y-1">
						<p className="wp-kicker">{t("governance.pendingTitle", { count: report.pending.length })}</p>
						<ul className="grid gap-1.5">
							{report.pending.map((request) => (
								<RequestLine
									key={request.id}
									request={request}
									canAnswer={Boolean(may?.approve)}
									busy={answering === request.id}
									onAnswer={(approved) => void answer(request.id, approved)}
								/>
							))}
						</ul>
					</div>
				)}
				{report && (
					<div className="space-y-2">
						<MetricsChips metrics={report.metrics} />
						<div className="flex flex-wrap items-center gap-2">
							<p className="wp-kicker mr-auto">{t("governance.decisionsTitle")}</p>
							{may?.export && (
								<>
									<CharterButton variant="ghost" size="sm" icon={Download} onClick={() => void exportAs("csv")}>
										{t("governance.exportCsv")}
									</CharterButton>
									<CharterButton variant="ghost" size="sm" icon={Download} onClick={() => void exportAs("json")}>
										{t("governance.exportJson")}
									</CharterButton>
								</>
							)}
						</div>
						<DecisionList events={report.events} />
					</div>
				)}
			</Panel>
		</Section>
	);
}
