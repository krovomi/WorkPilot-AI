import { useTranslation } from "react-i18next";
import {
	CODE_MODES,
	type CodeModePhase,
	type CodeModeSetting,
	type PhaseCodeMode,
} from "../../../shared/utils/code-mode";
import { cn } from "../../lib/utils";

interface PhaseCodeModePickerProps {
	phase: CodeModePhase;
	value: PhaseCodeMode;
	onChange: (next: PhaseCodeMode) => void;
	idPrefix: string;
	disabled?: boolean;
}

const CHOICES = ["default", ...CODE_MODES] as const;
type Choice = (typeof CHOICES)[number];

/**
 * One phase's code mode, under the task's per-phase engines: Settings' mode
 * (the default), or this task's own. Shown only while the Settings switch is
 * not off, since off wins over every task.
 */
export function PhaseCodeModePicker({
	phase,
	value,
	onChange,
	idPrefix,
	disabled = false,
}: PhaseCodeModePickerProps) {
	const { t } = useTranslation(["tasks"]);
	const current: Choice = value[phase] ?? "default";
	const choose = (choice: Choice) => {
		const next = { ...value };
		if (choice === "default") delete next[phase];
		else next[phase] = choice as CodeModeSetting;
		onChange(next);
	};
	return (
		<fieldset className="flex flex-wrap items-center gap-2">
			<legend className="contents text-xs font-medium text-muted-foreground">
				{t("tasks:engine.codeMode.label")}
			</legend>
			<div className="flex gap-1">
				{CHOICES.map((choice) => (
					<button
						key={choice}
						type="button"
						disabled={disabled}
						aria-pressed={current === choice}
						data-testid={`${idPrefix}-code-mode-${choice}`}
						onClick={() => choose(choice)}
						className={cn(
							"rounded border px-2 py-0.5 text-2xs transition-colors",
							current === choice
								? "border-primary bg-primary/10 text-primary"
								: "border-border text-muted-foreground hover:text-foreground",
						)}
					>
						{t(`tasks:engine.codeMode.${choice}`)}
					</button>
				))}
			</div>
		</fieldset>
	);
}
