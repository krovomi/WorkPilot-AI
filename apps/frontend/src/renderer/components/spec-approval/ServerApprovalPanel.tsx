import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
	SERVER_CRITICALITIES,
	type ServerCardApproval,
	type ServerCriticality,
} from "@shared/types/server-approval";
import { formatAppDateTime } from "../../lib/date-format";
import { Chip, Chips, Notice, Panel } from "../charter";

interface ServerApprovalPanelProps {
	/** The task of a server card. The view remounts it to read it again. */
	readonly taskId: string;
}

/**
 * A server card's approval: how critical it is (which sets how many people
 * approve it), the approvals it has and the roles still missing. The server
 * decides who may change the criticality and answers with the approval as it
 * then stands (`shared_board/approvals.py`).
 */
export function ServerApprovalPanel({ taskId }: ServerApprovalPanelProps): React.ReactElement {
	const { t } = useTranslation(["specApproval"]);
	const [approval, setApproval] = useState<ServerCardApproval | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		const result = await globalThis.electronAPI.getServerCardApproval(taskId);
		if (result.success && result.data) {
			setApproval(result.data);
			setError(null);
		} else {
			setError(result.error ?? t("specApproval:server.loadFailed"));
		}
	}, [taskId, t]);

	useEffect(() => {
		void load();
	}, [load]);

	async function choose(level: ServerCriticality) {
		if (!approval || level === approval.criticality) return;
		setSaving(true);
		try {
			const result = await globalThis.electronAPI.setServerCardCriticality(taskId, level);
			if (result.success && result.data) {
				setApproval(result.data);
				setError(null);
			} else {
				setError(result.error ?? t("specApproval:server.saveFailed"));
			}
		} finally {
			setSaving(false);
		}
	}

	return (
		<Panel data-testid="server-approval-panel">
			<span className="wp-kicker">{t("specApproval:server.heading")}</span>
			{error && (
				<Notice tone="red" icon={AlertTriangle} role="alert" className="mt-2">
					{error}
				</Notice>
			)}
			{approval && (
				<div className="mt-2 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm">{t("specApproval:server.criticality")}</span>
						<Chips>
							{SERVER_CRITICALITIES.map((level) => (
								<Chip
									key={level}
									tone={level === "high" ? "red" : level === "medium" ? "amber" : "green"}
									pressed={approval.criticality === level}
									onClick={saving ? undefined : () => void choose(level)}
								>
									{t(`specApproval:server.levels.${level}`)}
								</Chip>
							))}
						</Chips>
						<span className="wp-meta">
							{t(`specApproval:server.sources.${approval.criticalitySource}`)}
						</span>
					</div>
					<div className="flex items-center gap-2 text-sm">
						<ShieldCheck className="h-4 w-4" aria-hidden="true" />
						<span>
							{t("specApproval:server.count", {
								given: approval.count,
								needed: approval.needed,
							})}
						</span>
						{approval.approved && (
							<Chip tone="green">{t("specApproval:server.approved")}</Chip>
						)}
					</div>
					{approval.missingRoles.length > 0 && (
						<p className="wp-meta">
							{t("specApproval:server.missingRoles", {
								roles: approval.missingRoles.join(", "),
							})}
						</p>
					)}
					{approval.approvals.length > 0 && (
						<ul className="space-y-1 text-sm">
							{approval.approvals.map((entry) => (
								<li key={`${entry.by}-${entry.at}`}>
									{entry.for
										? t("specApproval:server.byFor", {
												by: entry.by,
												for: entry.for,
												at: formatAppDateTime(entry.at),
											})
										: t("specApproval:server.by", {
												by: entry.by,
												at: formatAppDateTime(entry.at),
											})}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</Panel>
	);
}

export default ServerApprovalPanel;
