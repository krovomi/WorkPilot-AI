/**
 * A task's own say on the automatic split (`apps/backend/task_split/`): keep
 * it whole, or give it its own ceiling of changed lines per pull request
 * instead of the project's. Empty means the project's ceiling.
 */

import { useTranslation } from "react-i18next";
import type { TaskKind } from "../../../shared/types";
import {
	autoSplitCeilingFor,
	SPLIT_MAX_LINES_RANGE,
	wholeInRange,
} from "../../../shared/utils/task-split";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface AutoSplitValue {
	/** True keeps the task whole. */
	noSplit: boolean;
	/** The task's ceiling as typed; empty is the project's. */
	maxLines: string;
}

export const DEFAULT_AUTO_SPLIT_VALUE: AutoSplitValue = {
	noSplit: false,
	maxLines: "",
};

/** The value a task's metadata holds. */
export function autoSplitValueFrom(metadata?: {
	noSplit?: boolean;
	splitMaxLines?: number;
}): AutoSplitValue {
	return {
		noSplit: metadata?.noSplit === true,
		maxLines:
			metadata?.splitMaxLines !== undefined ? String(metadata.splitMaxLines) : "",
	};
}

/**
 * The metadata keys the value writes; `undefined` removes a key, so that a
 * task back on the project's defaults stores nothing.
 */
export function autoSplitMetadata(value: AutoSplitValue): {
	noSplit?: boolean;
	splitMaxLines?: number;
} {
	return {
		noSplit: value.noSplit ? true : undefined,
		splitMaxLines: value.noSplit
			? undefined
			: wholeInRange(value.maxLines, SPLIT_MAX_LINES_RANGE),
	};
}

/** Whether the typed ceiling is one the backend will use (empty is fine). */
export function isAutoSplitValueValid(value: AutoSplitValue): boolean {
	return (
		value.noSplit ||
		value.maxLines.trim() === "" ||
		wholeInRange(value.maxLines, SPLIT_MAX_LINES_RANGE) !== undefined
	);
}

interface AutoSplitFieldsProps {
	value: AutoSplitValue;
	onChange: (value: AutoSplitValue) => void;
	/** The project's ceiling for this task's kind, shown as the placeholder. */
	projectMaxLines?: number;
	/** The task's kind (or the one its category means), named in the placeholder. */
	kind?: TaskKind;
	/** The project turned the split off: the task cannot turn it on alone. */
	projectDisabled?: boolean;
	disabled?: boolean;
	idPrefix?: string;
}

export function AutoSplitFields({
	value,
	onChange,
	projectMaxLines,
	kind = "feature",
	projectDisabled = false,
	disabled = false,
	idPrefix = "",
}: AutoSplitFieldsProps) {
	const { t } = useTranslation(["tasks"]);
	const prefix = idPrefix ? `${idPrefix}-` : "";
	const ceiling = projectMaxLines ?? autoSplitCeilingFor(undefined, kind);
	const kindLabel = t(`tasks:kind.values.${kind}`);
	const valid = isAutoSplitValueValid(value);
	const enabled = !value.noSplit && !projectDisabled;

	return (
		<div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
			<div className="flex items-start gap-3">
				<Checkbox
					id={`${prefix}auto-split`}
					checked={enabled}
					onCheckedChange={(checked) =>
						onChange({ ...value, noSplit: checked !== true })
					}
					disabled={disabled || projectDisabled}
					className="mt-0.5"
				/>
				<div className="flex-1 space-y-1">
					<Label
						htmlFor={`${prefix}auto-split`}
						className="cursor-pointer text-sm font-medium text-foreground"
					>
						{t("tasks:form.autoSplit.label")}
					</Label>
					<p className="text-xs text-muted-foreground">
						{projectDisabled
							? t("tasks:form.autoSplit.projectOff")
							: t("tasks:form.autoSplit.description")}
					</p>
				</div>
			</div>
			{enabled && (
				<div className="space-y-1 pl-7">
					<Label
						htmlFor={`${prefix}auto-split-lines`}
						className="text-xs font-medium text-foreground"
					>
						{t("tasks:form.autoSplit.maxLinesLabel")}
					</Label>
					<Input
						id={`${prefix}auto-split-lines`}
						type="number"
						inputMode="numeric"
						min={SPLIT_MAX_LINES_RANGE[0]}
						max={SPLIT_MAX_LINES_RANGE[1]}
						step={50}
						value={value.maxLines}
						placeholder={
							ceiling === undefined
								? t("tasks:form.autoSplit.maxLinesPlaceholderNever", {
										kind: kindLabel,
									})
								: t("tasks:form.autoSplit.maxLinesPlaceholder", {
										count: ceiling,
										kind: kindLabel,
									})
						}
						onChange={(event) =>
							onChange({ ...value, maxLines: event.target.value })
						}
						disabled={disabled}
						aria-invalid={!valid}
						className="h-8 w-40"
					/>
					<p
						className={
							valid ? "text-xs text-muted-foreground" : "text-xs text-destructive"
						}
					>
						{valid
							? t("tasks:form.autoSplit.maxLinesHelp")
							: t("tasks:form.autoSplit.maxLinesInvalid", {
									min: SPLIT_MAX_LINES_RANGE[0],
									max: SPLIT_MAX_LINES_RANGE[1],
								})}
					</p>
				</div>
			)}
		</div>
	);
}
