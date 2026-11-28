/**
 * Monthly token budgets per person, group or project (`usage.read` to read,
 * `usage.write` to set or remove): each with this month's use, the
 * organization's own budget (set in Quotas), and the last alerts sent at 80 %
 * and 100 %. A blocking budget refuses new runs once spent. The server checks
 * the permission, the target (a member, group or project of the organization)
 * and the amount again; this pane only offers what it would accept.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	UsageBudget,
	UsageBudgetScope,
	UsageBudgets as Budgets,
} from "@shared/types/server-usage";
import { Button, Input, Label, NativeSelect } from "@/components/ui";
import { useAdminStore } from "@/stores/admin-store";
import { usePermission } from "@/stores/permissions-store";
import { formatCount, formatDay, formatRate, formatTokens } from "./usage-format";

const SCOPES: readonly UsageBudgetScope[] = ["person", "group", "project"];
const MAX_TOKENS = 10 ** 12;

function api() {
	return globalThis.electronAPI?.serverUsage ?? null;
}

/** A whole number of tokens within the server's bounds, or null. */
export function tokensOf(raw: string): number | null {
	const value = Number(raw.replace(/[\s_.,  ]/g, ""));
	return raw.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= MAX_TOKENS
		? value
		: null;
}

function percent(value: number): string {
	return formatRate(value / 100);
}

function Meter({ budget }: { readonly budget: UsageBudget }) {
	const tone =
		budget.percent >= 100 ? "bg-destructive" : budget.percent >= 80 ? "bg-warning" : "bg-primary";
	return (
		<div className="h-1.5 w-24 rounded bg-muted" aria-hidden="true">
			<div className={`h-1.5 rounded ${tone}`} style={{ width: `${Math.min(budget.percent, 100)}%` }} />
		</div>
	);
}

export function UsageBudgets() {
	const { t } = useTranslation("administration");
	const canWrite = usePermission("usage.write");
	const members = useAdminStore((s) => s.members);
	const groups = useAdminStore((s) => s.groups);
	const projects = useAdminStore((s) => s.groupProjects);
	const loadMembers = useAdminStore((s) => s.loadMembers);
	const loadGroups = useAdminStore((s) => s.loadGroups);
	const loadProjects = useAdminStore((s) => s.loadGroupProjects);

	const [budgets, setBudgets] = useState<Budgets | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [scope, setScope] = useState<UsageBudgetScope>("person");
	const [target, setTarget] = useState("");
	const [tokens, setTokens] = useState("");
	const [block, setBlock] = useState(false);

	const take = useCallback((result: { ok: true; data: Budgets } | { ok: false; error: string }) => {
		if (result.ok) {
			setBudgets(result.data);
			setError(null);
		} else setError(result.error);
	}, []);

	useEffect(() => {
		void loadMembers();
		void loadGroups();
		void loadProjects();
		void api()?.getBudgets().then(take);
	}, [loadMembers, loadGroups, loadProjects, take]);

	const targets = useMemo(() => {
		if (scope === "person") {
			return members.map((m) => ({ value: m.user_id, label: m.display_name || m.email }));
		}
		const list = scope === "group" ? groups : projects;
		return list.map((g) => ({ value: g.id, label: g.name }));
	}, [scope, members, groups, projects]);

	const amount = tokensOf(tokens);
	const valid = target !== "" && amount !== null;
	const names = useMemo(
		() => new Map((budgets?.budgets ?? []).map((b) => [b.id, b.name ?? t("usage.budgets.unknown")])),
		[budgets, t],
	);

	async function save() {
		const bridge = api();
		if (!bridge || amount === null || !target) return;
		setBusy(true);
		const result = await bridge.setBudget({ scope, target_id: target, monthly_tokens: amount, block });
		setBusy(false);
		take(result);
		if (result.ok) {
			setTarget("");
			setTokens("");
			setBlock(false);
		}
	}

	async function remove(id: string) {
		const bridge = api();
		if (!bridge) return;
		setBusy(true);
		take(await bridge.removeBudget(id));
		setBusy(false);
	}

	/** Fill the form with a budget, to change it. */
	function edit(budget: UsageBudget) {
		if (!SCOPES.includes(budget.scope as UsageBudgetScope) || !budget.target_id) return;
		setScope(budget.scope as UsageBudgetScope);
		setTarget(budget.target_id);
		setTokens(String(budget.monthly_tokens));
		setBlock(budget.block);
	}

	if (!budgets) {
		return error ? (
			<p role="alert" className="text-sm text-destructive">
				{t("usage.failed", { error })}
			</p>
		) : (
			<p className="text-sm text-muted-foreground">{t("common.loading")}</p>
		);
	}

	const own = budgets.organization;

	return (
		<div className="max-w-3xl space-y-6">
			<p className="text-sm text-muted-foreground">{t("usage.budgets.description")}</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{t("usage.failed", { error })}
				</p>
			)}

			<section className="space-y-1">
				<h3 className="text-sm font-semibold">{t("usage.budgets.organization")}</h3>
				<p className="text-sm text-muted-foreground">
					{own
						? t("usage.budgets.organizationHint", {
								used: formatTokens(own.used),
								limit: formatTokens(own.monthly_tokens),
								percent: percent(own.percent),
							})
						: t("usage.budgets.noOrganization")}
				</p>
			</section>

			<section className="space-y-2">
				<h3 className="text-sm font-semibold">{t("usage.budgets.list")}</h3>
				{budgets.budgets.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("usage.budgets.empty")}</p>
				) : (
					<table className="w-full text-sm">
						<thead className="text-left text-xs text-muted-foreground">
							<tr>
								<th className="py-1 font-medium">{t("usage.budgets.scope")}</th>
								<th className="py-1 font-medium">{t("usage.budgets.name")}</th>
								<th className="py-1 text-right font-medium">{t("usage.budgets.limit")}</th>
								<th className="py-1 text-right font-medium">{t("usage.budgets.used")}</th>
								<th className="py-1 font-medium">{t("usage.budgets.block")}</th>
								{canWrite && <th className="py-1" />}
							</tr>
						</thead>
						<tbody>
							{budgets.budgets.map((budget) => {
								const name = budget.name ?? t("usage.budgets.unknown");
								return (
									<tr key={`${budget.scope}-${budget.target_id}-${budget.id}`} className="border-t border-border">
										<td className="py-1">
											{t(`usage.budgets.scopes.${budget.scope}`, { defaultValue: budget.scope })}
										</td>
										<td className="py-1">
											{canWrite ? (
												<button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => edit(budget)}>
													{name}
												</button>
											) : (
												name
											)}
										</td>
										<td className="py-1 text-right">{formatTokens(budget.monthly_tokens)}</td>
										<td className="py-1">
											<div className="flex items-center justify-end gap-2">
												<span>
													{formatTokens(budget.used)}
													<span className="ml-1 text-muted-foreground">{percent(budget.percent)}</span>
												</span>
												<Meter budget={budget} />
											</div>
										</td>
										<td className="py-1">{budget.block ? t("usage.budgets.yes") : t("usage.budgets.no")}</td>
										{canWrite && (
											<td className="py-1 text-right">
												{budget.id && (
													<Button
														size="sm"
														variant="ghost"
														disabled={busy}
														aria-label={t("usage.budgets.removeLabel", { name })}
														onClick={() => budget.id && void remove(budget.id)}
													>
														{t("usage.budgets.remove")}
													</Button>
												)}
											</td>
										)}
									</tr>
								);
							})}
						</tbody>
					</table>
				)}
			</section>

			{canWrite && (
				<section className="space-y-3">
					<div>
						<h3 className="text-sm font-semibold">{t("usage.budgets.set")}</h3>
						<p className="text-xs text-muted-foreground">{t("usage.budgets.setHint")}</p>
					</div>
					<div className="flex flex-wrap items-end gap-3">
						<div className="space-y-1">
							<Label htmlFor="budget-scope">{t("usage.budgets.scope")}</Label>
							<NativeSelect
								id="budget-scope"
								value={scope}
								onChange={(e) => {
									setScope(e.target.value as UsageBudgetScope);
									setTarget("");
								}}
							>
								{SCOPES.map((s) => (
									<option key={s} value={s}>
										{t(`usage.budgets.scopes.${s}`)}
									</option>
								))}
							</NativeSelect>
						</div>
						<div className="min-w-56 space-y-1">
							<Label htmlFor="budget-target">{t("usage.budgets.target")}</Label>
							<NativeSelect id="budget-target" value={target} onChange={(e) => setTarget(e.target.value)}>
								<option value="">{t("usage.budgets.choose")}</option>
								{targets.map((o) => (
									<option key={o.value} value={o.value}>
										{o.label}
									</option>
								))}
							</NativeSelect>
						</div>
						<div className="space-y-1">
							<Label htmlFor="budget-tokens">{t("usage.budgets.tokens")}</Label>
							<Input
								id="budget-tokens"
								inputMode="numeric"
								value={tokens}
								onChange={(e) => setTokens(e.target.value)}
							/>
						</div>
					</div>
					{tokens !== "" && amount === null && (
						<p className="text-xs text-destructive">{t("usage.budgets.invalidTokens")}</p>
					)}
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
						{t("usage.budgets.blockToggle")}
					</label>
					<Button onClick={() => void save()} disabled={!valid || busy}>
						{t("usage.budgets.save")}
					</Button>
				</section>
			)}

			<section className="space-y-2">
				<h3 className="text-sm font-semibold">{t("usage.budgets.alerts")}</h3>
				{budgets.alerts.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t("usage.budgets.noAlerts")}</p>
				) : (
					<table className="w-full text-sm">
						<thead className="text-left text-xs text-muted-foreground">
							<tr>
								<th className="py-1 font-medium">{t("usage.budgets.month")}</th>
								<th className="py-1 font-medium">{t("usage.budgets.name")}</th>
								<th className="py-1 text-right font-medium">{t("usage.budgets.threshold")}</th>
								<th className="py-1 text-right font-medium">{t("usage.budgets.recipients")}</th>
							</tr>
						</thead>
						<tbody>
							{budgets.alerts.map((alert) => (
								<tr
									key={`${alert.budget_id}-${alert.month}-${alert.threshold}`}
									className="border-t border-border"
								>
									<td className="py-1">{formatDay(alert.month, { month: "long", year: "numeric" })}</td>
									<td className="py-1">
										{alert.budget_id
											? (names.get(alert.budget_id) ?? t("usage.budgets.unknown"))
											: t("usage.budgets.organization")}
									</td>
									<td className="py-1 text-right">{percent(alert.threshold)}</td>
									<td className="py-1 text-right">{formatCount(alert.recipients)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
		</div>
	);
}
