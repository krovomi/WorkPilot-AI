import { Download, RefreshCw, ShieldAlert } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AuditExportFormat, GovernanceReport } from "../../../shared/types/governance";
import { CharterButton, Notice, Panel, Section } from "../charter";
import { DecisionList, MetricsChips, PolicySections } from "./governance-parts";

/**
 * The governance sections of `workpilot.policy.yaml`, read only: the hours, the
 * files, the token budgets and the circuit-breaker limit every agent is held
 * to, why the file is refused when it is, the policy's last decisions and
 * their counts, and the export of its audit trail.
 */
export function GovernancePolicyPanel({ projectPath }: { readonly projectPath: string }): React.ReactElement {
	const { t } = useTranslation("settings");
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

	const events = report?.events ?? [];
	const metrics = report?.metrics ?? null;

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
				{report && <PolicySections report={report} />}
				<div className="space-y-2">
					{metrics && <MetricsChips metrics={metrics} />}
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
					<DecisionList events={events} />
				</div>
			</Panel>
		</Section>
	);
}
