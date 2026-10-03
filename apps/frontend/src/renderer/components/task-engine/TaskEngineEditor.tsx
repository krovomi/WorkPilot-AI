import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	ENGINE_PHASES,
	type EnginePhase,
	type EngineTrio,
	isUniformEngine,
	seedEngine,
	type TaskEngine,
} from "../../../shared/utils/task-engine";
import { useConfiguredProviders } from "../../hooks/useConfiguredProviders";
import { useSettingsStore } from "../../stores/settings-store";
import { EngineTrioPicker } from "./EngineTrioPicker";

interface TaskEngineEditorProps {
	engine: TaskEngine;
	/**
	 * A state setter: several pickers can correct their model in the same
	 * render, and each update must build on the previous one.
	 */
	onChange: Dispatch<SetStateAction<TaskEngine>>;
	idPrefix: string;
	disabled?: boolean;
}

/**
 * The engine of one task: one Provider × LLM × Effort for the whole task, and
 * under "Advanced", one per phase (spec, planning, coding, QA).
 *
 * What is chosen here belongs to the task and to nothing else. The default
 * provider in Settings only seeds a new task; changing it later moves no task.
 *
 * The task-wide picker shows the coding phase — the one that does the work —
 * and a change made there applies to every phase. Changing its provider takes
 * that provider's presets (Settings → Agent: per-phase models and effort), so
 * a planning phase on Opus and a coding phase on Sonnet stay that way on a new
 * Claude account, and every model comes from the new provider's catalogue.
 */
export function TaskEngineEditor({
	engine,
	onChange,
	idPrefix,
	disabled = false,
}: TaskEngineEditorProps) {
	const { t } = useTranslation(["tasks", "settings"]);
	const settings = useSettingsStore((s) => s.settings);
	const { providers, loading } = useConfiguredProviders();
	const uniform = isUniformEngine(engine);
	const [advanced, setAdvanced] = useState(!uniform);

	// A task whose phases were already set apart opens on them.
	useEffect(() => {
		if (!uniform) setAdvanced(true);
	}, [uniform]);

	const onGlobalChange = useCallback(
		(trio: EngineTrio, reason: "user" | "normalize") => {
			onChange((prev) => {
				const current = prev.coding;
				if (trio.provider !== current.provider) {
					return seedEngine(settings, trio.provider);
				}
				const next = {} as TaskEngine;
				for (const phase of ENGINE_PHASES) {
					const phaseTrio = { ...prev[phase] };
					// A person's choice applies to every phase; the picker's own
					// correction only to the phases that showed the corrected model.
					if (
						trio.model !== current.model &&
						(reason === "user" || phaseTrio.model === current.model)
					) {
						phaseTrio.model = trio.model;
					}
					if (trio.effort !== current.effort) phaseTrio.effort = trio.effort;
					next[phase] = phaseTrio;
				}
				return next;
			});
		},
		[onChange, settings],
	);

	const onPhaseChange = useCallback(
		(phase: EnginePhase) => (trio: EngineTrio) => {
			onChange((prev) => ({ ...prev, [phase]: trio }));
		},
		[onChange],
	);

	if (loading && providers.length === 0) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				<span>{t("tasks:modal.actions.loadingProviders")}</span>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				<div className="text-sm font-medium text-foreground">
					{t("tasks:engine.taskWide")}
				</div>
				<EngineTrioPicker
					value={engine.coding}
					onChange={onGlobalChange}
					providers={providers}
					idPrefix={`${idPrefix}-all`}
					disabled={disabled}
				/>
				<p className="text-xs text-muted-foreground">
					{t("tasks:engine.ownedByTask")}
				</p>
			</div>

			<button
				type="button"
				onClick={() => setAdvanced((open) => !open)}
				aria-expanded={advanced}
				aria-controls={`${idPrefix}-phases`}
				className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				{advanced ? (
					<ChevronDown className="h-4 w-4" />
				) : (
					<ChevronRight className="h-4 w-4" />
				)}
				{t("tasks:engine.perPhase")}
				{!uniform && (
					<span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
						{t("tasks:engine.mixed")}
					</span>
				)}
			</button>

			{advanced && (
				<div
					id={`${idPrefix}-phases`}
					className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
				>
					{ENGINE_PHASES.map((phase) => (
						<div key={phase} className="space-y-1">
							<div className="text-xs font-semibold text-foreground">
								{t(`settings:agentProfile.phases.${phase}.label`)}
							</div>
							<EngineTrioPicker
								value={engine[phase]}
								onChange={onPhaseChange(phase)}
								providers={providers}
								idPrefix={`${idPrefix}-${phase}`}
								disabled={disabled}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
