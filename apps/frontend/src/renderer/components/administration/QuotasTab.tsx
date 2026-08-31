/**
 * Per-tenant ceilings.
 *
 * An empty field means unlimited, which is also the default: an organization
 * with no quota row is unconstrained, so an upgraded deployment behaves exactly
 * as it did before quotas existed.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermission } from "@/stores/permissions-store";

type Field =
	| "max_users"
	| "max_projects"
	| "max_concurrent_runs"
	| "monthly_token_budget";

const FIELDS: Field[] = [
	"max_users",
	"max_projects",
	"max_concurrent_runs",
	"monthly_token_budget",
];

const USAGE_OF: Partial<Record<Field, "used_users" | "used_projects" | "used_concurrent_runs">> =
	{
		max_users: "used_users",
		max_projects: "used_projects",
		max_concurrent_runs: "used_concurrent_runs",
	};

export function QuotasTab() {
	const { t } = useTranslation("administration");
	const quotas = useAdminStore((s) => s.quotas);
	const loadQuotas = useAdminStore((s) => s.loadQuotas);
	const saveQuotas = useAdminStore((s) => s.saveQuotas);
	const canWrite = usePermission("org.quota.write");

	const [draft, setDraft] = useState<Record<Field, string>>({
		max_users: "",
		max_projects: "",
		max_concurrent_runs: "",
		monthly_token_budget: "",
	});
	const [hardStop, setHardStop] = useState(false);

	useEffect(() => {
		void loadQuotas();
	}, [loadQuotas]);

	useEffect(() => {
		if (!quotas) return;
		setDraft({
			max_users: quotas.max_users?.toString() ?? "",
			max_projects: quotas.max_projects?.toString() ?? "",
			max_concurrent_runs: quotas.max_concurrent_runs?.toString() ?? "",
			monthly_token_budget: quotas.monthly_token_budget?.toString() ?? "",
		});
		setHardStop(quotas.enforce_hard_stop);
	}, [quotas]);

	async function save() {
		const payload: Record<string, number | null | boolean> = {
			enforce_hard_stop: hardStop,
		};
		for (const field of FIELDS) {
			const raw = draft[field].trim();
			payload[field] = raw === "" ? null : Number(raw);
		}
		await saveQuotas(payload);
	}

	return (
		<div className="max-w-2xl space-y-6">
			<p className="text-sm text-muted-foreground">{t("quotas.description")}</p>

			<div className="space-y-4">
				{FIELDS.map((field) => {
					const usageKey = USAGE_OF[field];
					const used = usageKey && quotas ? quotas[usageKey] : null;
					return (
						<div key={field} className="space-y-1">
							<Label htmlFor={`quota-${field}`}>{t(`quotas.${camel(field)}`)}</Label>
							<div className="flex items-center gap-3">
								<Input
									id={`quota-${field}`}
									type="number"
									min={0}
									inputMode="numeric"
									disabled={!canWrite}
									placeholder={t("quotas.unlimited")}
									value={draft[field]}
									onChange={(e) =>
										setDraft((prev) => ({ ...prev, [field]: e.target.value }))
									}
								/>
								{used !== null && used !== undefined && (
									<span className="text-xs text-muted-foreground whitespace-nowrap">
										{t("quotas.currentlyUsed", { count: used })}
									</span>
								)}
							</div>
						</div>
					);
				})}

				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={hardStop}
						disabled={!canWrite}
						onChange={(e) => setHardStop(e.target.checked)}
					/>
					{t("quotas.enforceHardStop")}
				</label>
				<p className="text-xs text-muted-foreground">
					{t("quotas.hardStopHint")}
				</p>
			</div>

			{canWrite && <Button onClick={save}>{t("common.save")}</Button>}
		</div>
	);
}

function camel(field: Field): string {
	return field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
