import { useTranslation } from "react-i18next";
import type {
	AutoSplitSettings as AutoSplitSettingsType,
	ProjectSettings as ProjectSettingsType,
} from "../../../shared/types";
import {
	AUTO_SPLIT_DEFAULT_MAX_FILES,
	AUTO_SPLIT_DEFAULT_MAX_LINES,
	SPLIT_MAX_FILES_RANGE,
	SPLIT_MAX_LINES_RANGE,
	wholeInRange,
} from "../../../shared/utils/task-split";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/**
 * The automatic split of a task too big for one small pull request
 * (`apps/backend/task_split/`), for the whole project: on or off, and the
 * ceilings a plan is measured against. A task can keep its own line ceiling
 * or stay whole (task form). An empty field is the default.
 */
export function AutoSplitSettings({
	settings,
	setSettings,
}: {
	readonly settings: ProjectSettingsType;
	readonly setSettings: React.Dispatch<
		React.SetStateAction<ProjectSettingsType>
	>;
}) {
	const { t } = useTranslation(["settings"]);
	const current = settings.autoSplit ?? {};
	const enabled = current.enabled !== false;

	const update = (patch: Partial<AutoSplitSettingsType>) =>
		setSettings((previous) => ({
			...previous,
			autoSplit: { ...(previous.autoSplit ?? {}), ...patch },
		}));

	const numberField = (
		key: "maxLines" | "maxFiles",
		range: readonly [number, number],
		fallback: number,
	) => {
		const value = current[key];
		const invalid =
			value !== undefined && wholeInRange(value, range) === undefined;
		return (
			<div className="space-y-1">
				<Label
					htmlFor={`auto-split-${key}`}
					className="text-xs font-medium text-foreground"
				>
					{t(`projectSections.general.autoSplit.${key}`)}
				</Label>
				<Input
					id={`auto-split-${key}`}
					type="number"
					inputMode="numeric"
					min={range[0]}
					max={range[1]}
					value={value ?? ""}
					placeholder={String(fallback)}
					onChange={(event) => {
						const raw = event.target.value.trim();
						update({ [key]: raw === "" ? undefined : Number(raw) });
					}}
					aria-invalid={invalid}
					className="h-8 w-32"
				/>
				{invalid && (
					<p className="text-xs text-destructive">
						{t("projectSections.general.autoSplit.invalid", {
							min: range[0],
							max: range[1],
						})}
					</p>
				)}
			</div>
		);
	};

	return (
		<div className="space-y-3 pt-2">
			<div className="flex items-center justify-between">
				<div className="space-y-0.5">
					<Label htmlFor="auto-split" className="font-normal text-foreground">
						{t("projectSections.general.autoSplit.label")}
					</Label>
					<p className="text-xs text-muted-foreground">
						{t("projectSections.general.autoSplit.description")}
					</p>
				</div>
				<Switch
					id="auto-split"
					checked={enabled}
					onCheckedChange={(checked) => update({ enabled: checked })}
				/>
			</div>
			{enabled && (
				<div className="flex flex-wrap gap-6 pl-1">
					{numberField(
						"maxLines",
						SPLIT_MAX_LINES_RANGE,
						AUTO_SPLIT_DEFAULT_MAX_LINES,
					)}
					{numberField(
						"maxFiles",
						SPLIT_MAX_FILES_RANGE,
						AUTO_SPLIT_DEFAULT_MAX_FILES,
					)}
				</div>
			)}
		</div>
	);
}
