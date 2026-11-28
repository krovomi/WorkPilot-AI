import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectCapturesConfig, ProjectEnvConfig } from "../../../shared/types";
import { SettingsGroup, SwitchRow } from "../project-settings/SettingsGroup";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

const MODES = ["auto", "always", "never"] as const;
const PUBLISH = ["auto", "review", "never"] as const;

/**
 * The project's captures for pull requests (`CAPTURES_*` of `.workpilot/.env`,
 * `apps/backend/pr_captures/settings.py`): when a task takes them, whether
 * personal data is replaced by fakes, and how they reach the PR. A card can
 * still say « always » or « never » for itself (its Captures tab).
 */
export function CapturesSettings({
	envConfig,
	updateEnvConfig,
}: {
	readonly envConfig: ProjectEnvConfig | null;
	readonly updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}) {
	const { t } = useTranslation(["settings"]);
	const captures = envConfig?.captures ?? {};
	const save = (patch: Partial<ProjectCapturesConfig>) =>
		updateEnvConfig({ captures: { ...captures, ...patch } });

	const [selectors, setSelectors] = useState(captures.maskSelectors ?? "");
	const [days, setDays] = useState(String(captures.retentionDays ?? 30));
	const [branch, setBranch] = useState(captures.branch ?? "");
	useEffect(() => setSelectors(captures.maskSelectors ?? ""), [captures.maskSelectors]);
	useEffect(() => setDays(String(captures.retentionDays ?? 30)), [captures.retentionDays]);
	useEffect(() => setBranch(captures.branch ?? ""), [captures.branch]);

	const choice = <T extends string>(
		id: string,
		label: string,
		description: string,
		value: T,
		values: readonly T[],
		onChange: (value: T) => void,
	) => (
		<div className="flex items-center justify-between gap-4">
			<div className="space-y-0.5">
				<Label htmlFor={`captures-${id}`} className="font-normal text-foreground">
					{label}
				</Label>
				<p className="text-xs text-muted-foreground">{description}</p>
			</div>
			<Select
				value={value}
				onValueChange={(next) => {
					const found = values.find((v) => v === next);
					if (found) onChange(found);
				}}
			>
				<SelectTrigger id={`captures-${id}`} className="w-56" aria-label={label}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{values.map((v) => (
						<SelectItem key={v} value={v}>
							{t(`settings:captures.${id}.${v}`)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);

	return (
		<div className="space-y-8">
			<SettingsGroup
				title={t("settings:captures.groups.when.title")}
				description={t("settings:captures.groups.when.description")}
			>
				{choice(
					"mode",
					t("settings:captures.modeLabel"),
					t("settings:captures.modeHint"),
					captures.mode ?? "auto",
					MODES,
					(mode) => save({ mode }),
				)}
				<SwitchRow
					id="captures-compare"
					label={t("settings:captures.compare")}
					description={t("settings:captures.compareHint")}
					checked={captures.compare !== false}
					onCheckedChange={(compare) => save({ compare })}
				/>
			</SettingsGroup>

			<SettingsGroup
				title={t("settings:captures.groups.privacy.title")}
				description={t("settings:captures.groups.privacy.description")}
			>
				<SwitchRow
					id="captures-mask"
					label={t("settings:captures.mask")}
					description={t("settings:captures.maskHint")}
					checked={captures.mask !== false}
					onCheckedChange={(mask) => save({ mask })}
				/>
				<div className="space-y-1.5">
					<Label htmlFor="captures-selectors" className="font-normal text-foreground">
						{t("settings:captures.selectors")}
					</Label>
					<p className="text-xs text-muted-foreground">{t("settings:captures.selectorsHint")}</p>
					<Input
						id="captures-selectors"
						value={selectors}
						onChange={(event) => setSelectors(event.target.value)}
						onBlur={() => {
							if (selectors !== (captures.maskSelectors ?? "")) {
								save({ maskSelectors: selectors });
							}
						}}
						placeholder={t("settings:captures.selectorsPlaceholder")}
					/>
				</div>
				<SwitchRow
					id="captures-unchecked"
					label={t("settings:captures.publishUnchecked")}
					description={t("settings:captures.publishUncheckedHint")}
					checked={captures.publishUnchecked === true}
					onCheckedChange={(publishUnchecked) => save({ publishUnchecked })}
				/>
			</SettingsGroup>

			<SettingsGroup
				title={t("settings:captures.groups.publish.title")}
				description={t("settings:captures.groups.publish.description")}
			>
				{choice(
					"publish",
					t("settings:captures.publishLabel"),
					t("settings:captures.publishHint"),
					captures.publish ?? "auto",
					PUBLISH,
					(publish) => save({ publish }),
				)}
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor="captures-retention" className="font-normal text-foreground">
							{t("settings:captures.retention")}
						</Label>
						<p className="text-xs text-muted-foreground">{t("settings:captures.retentionHint")}</p>
						<Input
							id="captures-retention"
							type="number"
							min={0}
							max={3650}
							value={days}
							onChange={(event) => setDays(event.target.value)}
							onBlur={() => {
								const value = Number.parseInt(days, 10);
								if (Number.isInteger(value) && value >= 0 && value <= 3650) {
									if (value !== captures.retentionDays) save({ retentionDays: value });
								} else {
									setDays(String(captures.retentionDays ?? 30));
								}
							}}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="captures-branch" className="font-normal text-foreground">
							{t("settings:captures.branch")}
						</Label>
						<p className="text-xs text-muted-foreground">{t("settings:captures.branchHint")}</p>
						<Input
							id="captures-branch"
							value={branch}
							onChange={(event) => setBranch(event.target.value)}
							onBlur={() => {
								if (branch !== (captures.branch ?? "")) save({ branch });
							}}
							placeholder="workpilot-captures"
						/>
					</div>
				</div>
			</SettingsGroup>
		</div>
	);
}
