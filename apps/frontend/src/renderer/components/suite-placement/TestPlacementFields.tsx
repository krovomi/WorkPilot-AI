import { useTranslation } from "react-i18next";
import type { TestPlacementMode } from "../../../shared/types";
import { TEST_PLACEMENT_MODES } from "../../../shared/types";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { placementModeOf } from "./suite-hold";

const PROJECT = "project";

/**
 * A card's own choice of where its long suites run, over the project's
 * (`testPlacement` in task_metadata.json, read by `qa/suite_placement.py`).
 * `undefined` keeps the project's choice.
 */
export function TestPlacementFields({
	value,
	onChange,
	disabled = false,
	idPrefix = "",
}: {
	readonly value?: TestPlacementMode;
	readonly onChange: (value: TestPlacementMode | undefined) => void;
	readonly disabled?: boolean;
	readonly idPrefix?: string;
}) {
	const { t } = useTranslation(["tasks"]);
	const id = `${idPrefix ? `${idPrefix}-` : ""}test-placement`;
	return (
		<div className="space-y-1 p-4 rounded-lg border border-border bg-muted/30">
			<Label htmlFor={id} className="text-sm font-medium text-foreground">
				{t("tasks:suitePlacement.form.label")}
			</Label>
			<NativeSelect
				id={id}
				value={value ?? PROJECT}
				disabled={disabled}
				onChange={(event) => onChange(placementModeOf(event.target.value))}
				className="w-full"
			>
				<option value={PROJECT}>{t("tasks:suitePlacement.form.project")}</option>
				{TEST_PLACEMENT_MODES.map((mode) => (
					<option key={mode} value={mode}>
						{t(`tasks:suitePlacement.form.options.${mode}`)}
					</option>
				))}
			</NativeSelect>
			<p className="text-xs text-muted-foreground">
				{t(
					value
						? `tasks:suitePlacement.modeHints.${value}`
						: "tasks:suitePlacement.form.projectHint",
				)}
			</p>
		</div>
	);
}
