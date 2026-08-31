/**
 * The organization's administrative history.
 *
 * Scoped to one tenant, so an org admin reads their own record and nobody
 * else's. Distinct from the agent audit trail, which is hash-chained on disk
 * and exported through its own endpoints.
 */
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermission } from "@/stores/permissions-store";

export function AuditTab() {
	const { t } = useTranslation("administration");
	const audit = useAdminStore((s) => s.audit);
	const loadAudit = useAdminStore((s) => s.loadAudit);
	const canExport = usePermission("audit.export");
	const [filter, setFilter] = useState("");

	useEffect(() => {
		void loadAudit();
	}, [loadAudit]);

	const rows = filter
		? audit.filter(
				(entry) =>
					entry.action.includes(filter) ||
					(entry.user_email ?? "").includes(filter),
			)
		: audit;

	function exportJson() {
		const blob = new Blob([JSON.stringify(rows, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `workpilot-audit-${new Date().toISOString().slice(0, 10)}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-3">
				<Input
					className="max-w-xs"
					placeholder={t("audit.filter")}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
				/>
				{canExport && rows.length > 0 && (
					<Button size="sm" variant="outline" onClick={exportJson}>
						<Download className="h-4 w-4 mr-1" />
						{t("audit.export")}
					</Button>
				)}
			</div>

			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t("audit.empty")}</p>
			) : (
				<div className="border border-border rounded-md overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border text-left">
								<th className="p-3 font-medium">{t("audit.columns.when")}</th>
								<th className="p-3 font-medium">{t("audit.columns.who")}</th>
								<th className="p-3 font-medium">{t("audit.columns.action")}</th>
								<th className="p-3 font-medium">{t("audit.columns.details")}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((entry) => (
								<tr key={entry.id} className="border-b border-border last:border-0">
									<td className="p-3 whitespace-nowrap text-muted-foreground">
										{new Date(entry.created_at).toLocaleString()}
									</td>
									<td className="p-3">{entry.user_email ?? "—"}</td>
									<td className="p-3 font-mono text-xs">{entry.action}</td>
									<td className="p-3 text-xs text-muted-foreground break-all">
										{entry.payload ? JSON.stringify(entry.payload) : ""}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
