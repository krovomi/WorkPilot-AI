import { Bell, Save, TrendingUp, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	BudgetLevel,
	CostBudgetConfig,
	CostBudgetStatus,
} from "../../../shared/types/cost-budget";
import { useToast } from "../../hooks/use-toast";
import { Bar, CharterButton, Chip, Notice, Panel, Section, type Tone } from "../charter";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { Switch } from "../ui/switch";

const LEVEL_TONE: Record<BudgetLevel, Tone> = {
	ok: "green",
	warning: "amber",
	critical: "red",
	exceeded: "red",
};

function usd(amount: number, language: string): string {
	return new Intl.NumberFormat(language, { style: "currency", currency: "USD" }).format(amount);
}

function amountOf(text: string): number {
	const value = Number(text);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Where the project's budget stands: spend, forecast, the tasks near their own limit. */
function BudgetStanding({ status }: { readonly status: CostBudgetStatus }) {
	const { t, i18n } = useTranslation("costEstimator");
	const { config } = status;
	const tone = LEVEL_TONE[status.level];
	const pct = Math.min(status.utilizationPct, 100);
	const money = (n: number) => usd(n, i18n.language);
	return (
		<Panel rail tone={tone} className="space-y-3">
			{config.limit > 0 ? (
				<>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="wp-title text-sm">{t(`budget.period.${config.period}`)}</span>
						<Chip tone={tone}>{t(`budget.level.${status.level}`, { pct: pct.toFixed(0) })}</Chip>
					</div>
					<Bar value={pct} tone={tone} />
					<div className="wp-meta flex flex-wrap justify-between gap-2">
						<span>
							{t(status.complete ? "budget.spent" : "budget.spentFloor", {
								amount: money(status.spent),
							})}
						</span>
						<span>{t("budget.remaining", { amount: money(status.remaining) })}</span>
						<span>{t("budget.total", { amount: money(config.limit) })}</span>
					</div>
					{config.period !== "total" && status.forecastEndOfPeriod > 0 && (
						<div className="flex flex-wrap items-center gap-2 text-xs">
							<TrendingUp className="h-3 w-3" aria-hidden="true" />
							<span className="wp-muted">{t("budget.forecast")}</span>
							<span className="font-medium">{money(status.forecastEndOfPeriod)}</span>
							{status.forecastEndOfPeriod > config.limit && (
								<Chip tone="red">{t("budget.overBudget")}</Chip>
							)}
						</div>
					)}
					{status.level !== "ok" && (
						<Notice tone={tone} icon={Bell}>
							{t(`budget.alert.${status.level}`, {
								spent: money(status.spent),
								limit: money(config.limit),
								action: t(`budget.action.${config.on_exceed}`),
							})}
						</Notice>
					)}
				</>
			) : (
				<p className="wp-muted text-xs">{t("budget.noProjectLimit")}</p>
			)}
			{status.tasksOverWarning.length > 0 && (
				<div className="space-y-1">
					<p className="text-xs font-medium">
						{t("budget.tasksNearLimit", { limit: money(config.task_limit) })}
					</p>
					<div className="wp-chips">
						{status.tasksOverWarning.slice(0, 8).map((task) => (
							<Chip
								key={task.specId}
								tone={task.spent >= config.task_limit ? "red" : "amber"}
								dot={false}
							>
								{task.specId} · {money(task.spent)}
							</Chip>
						))}
					</div>
				</div>
			)}
		</Panel>
	);
}

interface Draft {
	limit: string;
	period: CostBudgetConfig["period"];
	taskLimit: string;
	onExceed: CostBudgetConfig["on_exceed"];
	degrade: boolean;
	stall: boolean;
}

function draftOf(config: CostBudgetConfig): Draft {
	return {
		limit: config.limit > 0 ? String(config.limit) : "",
		period: config.period,
		taskLimit: config.task_limit > 0 ? String(config.task_limit) : "",
		onExceed: config.on_exceed,
		degrade: config.degrade,
		stall: config.stall_multiplier > 0,
	};
}

/** The budget's settings: what WorkPilot enforces before each agent session. */
function BudgetForm({
	projectPath,
	config,
	onSaved,
}: {
	readonly projectPath: string;
	readonly config: CostBudgetConfig;
	readonly onSaved: () => void;
}) {
	const { t } = useTranslation("costEstimator");
	const { toast } = useToast();
	const [draft, setDraft] = useState<Draft>(() => draftOf(config));
	const [saving, setSaving] = useState(false);
	useEffect(() => setDraft(draftOf(config)), [config]);
	const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
		setDraft((d) => ({ ...d, [key]: value }));

	const save = async () => {
		setSaving(true);
		try {
			const result = await globalThis.electronAPI.setCostBudget(projectPath, {
				...config,
				limit: amountOf(draft.limit),
				period: draft.period,
				task_limit: amountOf(draft.taskLimit),
				on_exceed: draft.onExceed,
				degrade: draft.degrade,
				stall_multiplier: draft.stall ? config.stall_multiplier || 3 : 0,
			});
			toast(
				result.success
					? { title: t("budget.form.saved") }
					: { variant: "destructive", title: t("budget.form.saveFailed") },
			);
			if (result.success) onSaved();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Panel className="space-y-4">
			<div className="grid gap-4 md:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor="budget-limit">{t("budget.form.projectLimit")}</Label>
					<div className="flex gap-2">
						<Input
							id="budget-limit"
							type="number"
							min={0}
							step="1"
							value={draft.limit}
							onChange={(e) => set("limit", e.target.value)}
						/>
						<NativeSelect
							aria-label={t("budget.form.period")}
							value={draft.period}
							onChange={(e) => set("period", e.target.value as Draft["period"])}
						>
							<option value="monthly">{t("budget.period.monthly")}</option>
							<option value="weekly">{t("budget.period.weekly")}</option>
							<option value="total">{t("budget.period.total")}</option>
						</NativeSelect>
					</div>
				</div>
				<div className="space-y-1">
					<Label htmlFor="budget-task-limit">{t("budget.form.taskLimit")}</Label>
					<Input
						id="budget-task-limit"
						type="number"
						min={0}
						step="0.5"
						value={draft.taskLimit}
						onChange={(e) => set("taskLimit", e.target.value)}
					/>
				</div>
			</div>
			<p className="wp-muted text-xs">{t("budget.form.usdHint")}</p>
			<div className="space-y-1">
				<Label htmlFor="budget-on-exceed">{t("budget.form.onExceed")}</Label>
				<NativeSelect
					id="budget-on-exceed"
					value={draft.onExceed}
					onChange={(e) => set("onExceed", e.target.value as Draft["onExceed"])}
				>
					<option value="pause">{t("budget.action.pause")}</option>
					<option value="warn">{t("budget.action.warn")}</option>
				</NativeSelect>
			</div>
			<div className="flex items-start gap-3">
				<Switch
					id="budget-degrade"
					checked={draft.degrade}
					onCheckedChange={(v: boolean) => set("degrade", v)}
				/>
				<div>
					<Label htmlFor="budget-degrade">{t("budget.form.degrade")}</Label>
					<p className="wp-muted text-xs">{t("budget.form.degradeHint")}</p>
				</div>
			</div>
			<div className="flex items-start gap-3">
				<Switch
					id="budget-stall"
					checked={draft.stall}
					onCheckedChange={(v: boolean) => set("stall", v)}
				/>
				<div>
					<Label htmlFor="budget-stall">{t("budget.form.stall")}</Label>
					<p className="wp-muted text-xs">{t("budget.form.stallHint")}</p>
				</div>
			</div>
			<div className="flex justify-end">
				<CharterButton variant="primary" icon={Save} busy={saving} onClick={save}>
					{t("budget.form.save")}
				</CharterButton>
			</div>
		</Panel>
	);
}

/** The project's cost budget on the Costs page: where it stands, and its settings. */
export function CostBudgetSection({
	projectPath,
	status,
	onSaved,
}: {
	readonly projectPath: string;
	readonly status: CostBudgetStatus;
	readonly onSaved: () => void;
}) {
	const { t } = useTranslation("costEstimator");
	return (
		<Section
			kicker={t("kickers.budget")}
			title={t("budget.title")}
			description={t("budget.description")}
			actions={
				status.configured ? undefined : (
					<Chip tone="muted" dot={false}>
						<Wallet className="h-3 w-3" aria-hidden="true" />
						{t("budget.notSet")}
					</Chip>
				)
			}
		>
			<div className="grid gap-4 lg:grid-cols-2">
				{status.configured && <BudgetStanding status={status} />}
				<BudgetForm projectPath={projectPath} config={status.config} onSaved={onSaved} />
			</div>
		</Section>
	);
}
