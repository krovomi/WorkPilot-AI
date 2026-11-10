import { Gauge as GaugeIcon, Save, TrendingDown } from "lucide-react";
import type React from "react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CarbonBudget, CarbonConfig, CarbonConfigInput } from "../../../shared/types/carbon-profiler";
import { CharterButton, Chip, Gauge, Notice, Panel, Section, type Tone } from "../charter";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { Switch } from "../ui/switch";

const STATE_TONES: Record<CarbonBudget["state"], Tone> = {
	none: "muted",
	ok: "green",
	warning: "amber",
	exceeded: "red",
};

export const kg = (grams: number) => (grams / 1000).toFixed(grams >= 100_000 ? 1 : 3);

/** Where the month stands against its budget. */
export function BudgetMeter({ budget }: { readonly budget: CarbonBudget }): React.ReactElement {
	const { t } = useTranslation("carbonProfiler");
	const tone = STATE_TONES[budget.state];
	return (
		<Section kicker={t("kickers.budget")} title={t("budget.title", { month: budget.month })}>
			{budget.state === "none" ? (
				<p className="wp-meta">{t("budget.none")}</p>
			) : (
				<Panel className="flex flex-wrap items-center gap-4" tone={tone} rail>
					<Gauge value={budget.percent ?? 0} tone={tone} label={`${Math.round(budget.percent ?? 0)}%`} />
					<div className="min-w-0 flex-1 space-y-1">
						<Chip tone={tone}>{t(`budget.states.${budget.state}`)}</Chip>
						<p className="text-sm">
							{t("budget.used", { used: kg(budget.usedG), budget: kg(budget.budgetG) })}
						</p>
						<p className="wp-meta">{t("budget.alertAt", { percent: budget.alertPercent })}</p>
					</div>
				</Panel>
			)}
			{budget.degraded && (
				<Notice tone="amber" icon={TrendingDown} className="mt-2">
					{t("budget.degraded")}
				</Notice>
			)}
		</Section>
	);
}

function toInput(config: CarbonConfig): CarbonConfigInput {
	const { regions: _regions, ...rest } = config;
	return rest;
}

/** The project's carbon settings: grid region, monthly budget, alerts, degraded mode, local power. */
export function CarbonSettings({
	config,
	saving,
	onSave,
}: {
	readonly config: CarbonConfig;
	readonly saving: boolean;
	readonly onSave: (config: CarbonConfigInput) => void;
}): React.ReactElement {
	const { t } = useTranslation("carbonProfiler");
	const id = useId();
	const [draft, setDraft] = useState<CarbonConfigInput>(() => toInput(config));
	useEffect(() => setDraft(toInput(config)), [config]);
	const set = <K extends keyof CarbonConfigInput>(key: K, value: CarbonConfigInput[K]) =>
		setDraft((current) => ({ ...current, [key]: value }));
	const numberOf = (value: string, fallback: number) => {
		const n = Number(value);
		return Number.isFinite(n) ? n : fallback;
	};

	return (
		<Section kicker={t("kickers.settings")} title={t("settings.title")} description={t("settings.description")}>
			<Panel className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor={`${id}-region`}>{t("settings.region")}</Label>
					<NativeSelect
						id={`${id}-region`}
						value={draft.region}
						onChange={(e) => set("region", e.target.value)}
						className="w-full"
					>
						{config.regions.map((region) => (
							<option key={region} value={region}>
								{t(`regions.${region}`, { defaultValue: region })}
							</option>
						))}
					</NativeSelect>
					<p className="wp-meta">{t("settings.regionHint")}</p>
				</div>
				<div className="space-y-1">
					<Label htmlFor={`${id}-budget`}>{t("settings.budget")}</Label>
					<Input
						id={`${id}-budget`}
						type="number"
						min={0}
						step={0.1}
						value={draft.monthlyBudgetKg}
						onChange={(e) => set("monthlyBudgetKg", Math.max(0, numberOf(e.target.value, 0)))}
					/>
					<p className="wp-meta">{t("settings.budgetHint")}</p>
				</div>
				<div className="space-y-1">
					<Label htmlFor={`${id}-alert`}>{t("settings.alert")}</Label>
					<Input
						id={`${id}-alert`}
						type="number"
						min={10}
						max={99}
						value={draft.alertPercent}
						onChange={(e) => set("alertPercent", Math.min(99, Math.max(10, numberOf(e.target.value, 80))))}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor={`${id}-power`}>{t("settings.localPower")}</Label>
					<Input
						id={`${id}-power`}
						type="number"
						min={1}
						max={5000}
						value={draft.localPowerW}
						disabled={draft.cpuOnly}
						onChange={(e) => set("localPowerW", Math.min(5000, Math.max(1, numberOf(e.target.value, 150))))}
					/>
				</div>
				<div className="flex items-start gap-3 sm:col-span-2">
					<Switch
						id={`${id}-degrade`}
						checked={draft.degrade}
						onCheckedChange={(checked) => set("degrade", checked)}
					/>
					<div>
						<Label htmlFor={`${id}-degrade`}>{t("settings.degrade")}</Label>
						<p className="wp-meta">{t("settings.degradeHint")}</p>
					</div>
				</div>
				<div className="flex items-start gap-3 sm:col-span-2">
					<Switch
						id={`${id}-cpu`}
						checked={draft.cpuOnly}
						onCheckedChange={(checked) => set("cpuOnly", checked)}
					/>
					<div>
						<Label htmlFor={`${id}-cpu`}>{t("settings.cpuOnly")}</Label>
						<p className="wp-meta">{t("settings.cpuOnlyHint")}</p>
					</div>
				</div>
				<div className="sm:col-span-2">
					<CharterButton icon={saving ? GaugeIcon : Save} busy={saving} onClick={() => onSave(draft)}>
						{t("settings.save")}
					</CharterButton>
				</div>
			</Panel>
		</Section>
	);
}
