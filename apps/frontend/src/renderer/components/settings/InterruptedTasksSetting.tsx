import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/types";
import {
	INTERRUPTED_LAUNCH_POLICIES,
	normalizeInterruptedLaunchPolicy,
} from "../../../shared/types/interrupted-tasks";
import { cn } from "../../lib/utils";

const K = "general.interruptedTasks";

interface InterruptedTasksSettingProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Settings › Agents: what a launch does with the Kanban builds the last exit
 * interrupted (main/ipc-handlers/task/interrupted-prompt.ts). The launch
 * dialog's « La prochaine fois » writes the same setting.
 */
export function InterruptedTasksSetting({ settings, onSettingsChange }: InterruptedTasksSettingProps) {
	const { t } = useTranslation("settings");
	const current = normalizeInterruptedLaunchPolicy(settings.interruptedTasksOnLaunch);
	return (
		<div>
			<h4 className="mb-1 flex items-center gap-2 text-sm font-semibold">
				<RotateCcw className="h-4 w-4 text-primary" />
				{t(`${K}.title`)}
			</h4>
			<p className="mb-3 text-xs text-muted-foreground">{t(`${K}.description`)}</p>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
				{INTERRUPTED_LAUNCH_POLICIES.map((policy) => (
					<button
						type="button"
						key={policy}
						data-testid={`interrupted-setting-${policy}`}
						aria-pressed={current === policy}
						onClick={() => onSettingsChange({ ...settings, interruptedTasksOnLaunch: policy })}
						className={cn(
							"flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
							current === policy
								? "border-primary bg-primary/5 ring-1 ring-primary"
								: "border-border hover:bg-accent/50",
						)}
					>
						<span className="text-sm font-medium">{t(`${K}.${policy}.label`)}</span>
						<span className="text-xs text-muted-foreground">{t(`${K}.${policy}.description`)}</span>
					</button>
				))}
			</div>
		</div>
	);
}
