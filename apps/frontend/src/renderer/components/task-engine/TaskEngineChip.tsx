import { Cpu } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { providerRegistry } from "../../../shared/services/providerRegistry";
import type { Task } from "../../../shared/types/task";
import {
	defaultEngineProvider,
	ENGINE_PHASES,
	isUniformEngine,
	resolveTaskEngine,
	seedEngine,
} from "../../../shared/utils/task-engine";
import { useSettingsStore } from "../../stores/settings-store";
import { effortLabel, shortModel } from "../formula-lab/formula-utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** A provider's name as the Settings show it, else the id itself. */
function providerName(provider: string): string {
	const id = provider === "claude" ? "anthropic" : provider;
	return providerRegistry.getProvider(id)?.label ?? provider;
}

interface TaskEngineChipProps {
	readonly task: Task;
	readonly onClick?: (event: React.MouseEvent) => void;
}

/**
 * What the task runs on, on its card: `Provider · model · effort`, or "Mixed"
 * when its phases differ, with every phase in the tooltip.
 *
 * Shown on every card, not only after a Formula Lab estimate: a task's engine
 * is its own, and the board is where several tasks on several providers are
 * read side by side.
 */
export function TaskEngineChip({ task, onClick }: TaskEngineChipProps) {
	const { t } = useTranslation(["tasks", "settings"]);
	const settings = useSettingsStore((s) => s.settings);
	const engine = useMemo(
		() =>
			resolveTaskEngine(
				task.metadata,
				seedEngine(
					settings,
					task.metadata?.provider || defaultEngineProvider(settings),
				),
			),
		[task.metadata, settings],
	);
	const uniform = isUniformEngine(engine);
	const main = engine.coding;
	const label = uniform
		? `${providerName(main.provider)} · ${shortModel(main.model)} · ${effortLabel(main.effort)}`
		: t("tasks:engine.chipMixed", { provider: providerName(main.provider) });

	const content = (
		<span className="flex min-w-0 items-center gap-1">
			<Cpu className="h-3 w-3 shrink-0" />
			<span className="max-w-[160px] truncate">{label}</span>
		</span>
	);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{onClick ? (
					<button
						type="button"
						onClick={(event) => {
							event.stopPropagation();
							onClick(event);
						}}
						aria-label={t("tasks:engine.chipAria", { engine: label })}
						className="flex items-center rounded-full border border-border bg-card/60 px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:border-primary/50 hover:bg-primary/5"
					>
						{content}
					</button>
				) : (
					<span className="flex items-center rounded-full border border-border bg-card/60 px-1.5 py-0.5 text-[10px] font-medium">
						{content}
					</span>
				)}
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">
				<div className="space-y-0.5 text-xs">
					{ENGINE_PHASES.map((phase) => (
						<div key={phase}>
							<span className="font-medium">
								{t(`settings:agentProfile.phases.${phase}.label`)}
							</span>
							{" — "}
							{providerName(engine[phase].provider)} ·{" "}
							{shortModel(engine[phase].model)} ·{" "}
							{effortLabel(engine[phase].effort)}
						</div>
					))}
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
