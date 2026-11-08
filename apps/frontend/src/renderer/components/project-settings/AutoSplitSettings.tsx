import { useTranslation } from "react-i18next";
import type {
	AutoSplitSettings as AutoSplitSettingsType,
	ProjectSettings as ProjectSettingsType,
	SplitKind,
} from "../../../shared/types";
import {
	AUTO_SPLIT_DEFAULT_MAX_FILES,
	AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND,
	SPLIT_KINDS,
	SPLIT_MAX_FILES_RANGE,
	SPLIT_MAX_LINES_RANGE,
	wholeInRange,
} from "../../../shared/utils/task-split";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

/**
 * The automatic split of a task too big for one small pull request
 * (`apps/backend/task_split/`), for the whole project: on or off, a ceiling
 * of lines to review per kind of task, and a ceiling of files. A task can
 * keep its own line ceiling or stay whole (task form). An empty field is the
 * default of its kind.
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
	const { t } = useTranslation(["settings", "tasks"]);
	const current = settings.autoSplit ?? {};
	const enabled = current.enabled !== false;
	const base = "settings:projectSections.general.autoSplit";

	const update = (patch: Partial<AutoSplitSettingsType>) =>
		setSettings((previous) => ({
			...previous,
			autoSplit: { ...(previous.autoSplit ?? {}), ...patch },
		}));

	const setKind = (kind: SplitKind, raw: string) => {
		const next = { ...(current.maxLinesByKind ?? {}) };
		if (raw.trim() === "") delete next[kind];
		else next[kind] = Number(raw.trim());
		update({ maxLinesByKind: next });
	};

	const field = (props: {
		id: string;
		label: string;
		value: number | undefined;
		range: readonly [number, number];
		fallback: number;
		onChange: (raw: string) => void;
	}) => {
		const invalid =
			props.value !== undefined &&
			wholeInRange(props.value, props.range) === undefined;
		return (
			<div className="space-y-1" key={props.id}>
				<Label
					htmlFor={props.id}
					className="text-xs font-medium text-foreground"
				>
					{props.label}
				</Label>
				<Input
					id={props.id}
					type="number"
					inputMode="numeric"
					min={props.range[0]}
					max={props.range[1]}
					value={props.value ?? ""}
					placeholder={String(props.fallback)}
					onChange={(event) => props.onChange(event.target.value)}
					aria-invalid={invalid}
					className="h-8 w-28"
				/>
				{invalid && (
					<p className="text-xs text-destructive">
						{t(`${base}.invalid`, {
							min: props.range[0],
							max: props.range[1],
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
						{t(`${base}.label`)}
					</Label>
					<p className="text-xs text-muted-foreground">
						{t(`${base}.description`)}
					</p>
				</div>
				<Switch
					id="auto-split"
					checked={enabled}
					onCheckedChange={(checked) => update({ enabled: checked })}
				/>
			</div>
			{enabled && (
				<div className="space-y-3 pl-1">
					<div className="space-y-1">
						<p className="text-xs font-medium text-foreground">
							{t(`${base}.byKindTitle`)}
						</p>
						<p className="text-xs text-muted-foreground">
							{t(`${base}.byKindHelp`)}
						</p>
					</div>
					<div className="flex flex-wrap gap-4">
						{SPLIT_KINDS.map((kind) =>
							field({
								id: `auto-split-lines-${kind}`,
								label: t(`tasks:kind.values.${kind}`),
								value: current.maxLinesByKind?.[kind],
								range: SPLIT_MAX_LINES_RANGE,
								fallback: AUTO_SPLIT_DEFAULT_MAX_LINES_BY_KIND[kind],
								onChange: (raw) => setKind(kind, raw),
							}),
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						{t(`${base}.neverSplit`)}
					</p>
					{field({
						id: "auto-split-maxFiles",
						label: t(`${base}.maxFiles`),
						value: current.maxFiles,
						range: SPLIT_MAX_FILES_RANGE,
						fallback: AUTO_SPLIT_DEFAULT_MAX_FILES,
						onChange: (raw) =>
							update({
								maxFiles: raw.trim() === "" ? undefined : Number(raw.trim()),
							}),
					})}
				</div>
			)}
		</div>
	);
}
