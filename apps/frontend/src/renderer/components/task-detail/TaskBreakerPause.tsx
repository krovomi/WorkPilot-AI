import { Mic, OctagonX, Repeat } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BreakerPauseDetail, Task } from "../../../shared/types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** The circuit breaker's record of a task it paused, or null. */
export function breakerPause(task: Task): BreakerPauseDetail | null {
	const paused = task.metadata?.paused;
	if (!paused?.enabled || paused.reason !== "tool_loop") return null;
	const detail = paused.breaker;
	return detail && typeof detail.tool === "string" && typeof detail.repeats === "number"
		? detail
		: null;
}

/**
 * Why a task the backend stopped is paused: the circuit breaker saw its agent
 * repeat a tool call (`agents/tool_breaker.py`), the person stopped every
 * agent at once, or said « stop » to the voice assistant. Resuming is the
 * Resume button beside it.
 */
export function TaskBreakerPause({ task }: { readonly task: Task }) {
	const { t } = useTranslation(["tasks"]);
	if (task.metadata?.paused?.enabled && task.metadata.paused.reason === "voice_stop") {
		return (
			<span
				className="inline-flex items-center gap-1 text-xs text-muted-foreground"
				data-testid="task-voice-stop-pause"
			>
				<Mic className="h-3.5 w-3.5" aria-hidden="true" />
				{t("tasks:breakerPause.voiceStop")}
			</span>
		);
	}
	if (task.metadata?.paused?.enabled && task.metadata.paused.reason === "kill_switch") {
		return (
			<span
				className="inline-flex items-center gap-1 text-xs text-muted-foreground"
				data-testid="task-kill-switch-pause"
			>
				<OctagonX className="h-3.5 w-3.5" aria-hidden="true" />
				{t("tasks:breakerPause.killSwitch")}
			</span>
		);
	}
	const detail = breakerPause(task);
	if (!detail) return null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="warning" size="sm" className="gap-1.5" data-testid="task-breaker-pause">
					<Repeat className="h-4 w-4" />
					{t("tasks:breakerPause.chip", { tool: detail.tool })}
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-80 space-y-3 text-sm">
				<p>{t("tasks:breakerPause.body", { tool: detail.tool, repeats: detail.repeats })}</p>
				<p className="text-xs text-muted-foreground">{t("tasks:breakerPause.hint")}</p>
			</PopoverContent>
		</Popover>
	);
}
