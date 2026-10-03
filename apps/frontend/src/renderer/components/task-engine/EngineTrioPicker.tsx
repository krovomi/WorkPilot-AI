import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	getModelTier,
	resolveModelForProviderCatalog,
	THINKING_LEVELS,
} from "../../../shared/constants/models";
import type { ThinkingLevel } from "../../../shared/types/settings";
import {
	isCustomModelSentinel,
	isLocalProvider,
} from "../../../shared/utils/local-models";
import type { EngineTrio } from "../../../shared/utils/task-engine";
import { buildModelSelectOptions } from "../../../shared/utils/task-thinking";
import type { ConfiguredProvider } from "../../hooks/useConfiguredProviders";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { cn } from "../../lib/utils";
import { useSettingsStore } from "../../stores/settings-store";
import { OfficialModelSearch } from "../task-detail/OfficialModelSearch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface EngineTrioPickerProps {
	value: EngineTrio;
	/**
	 * `reason` tells a person's choice ("user") from the picker bringing the
	 * model back into the provider's catalogue ("normalize"): an editor that
	 * spreads one picker over several phases spreads only the former.
	 */
	onChange: (trio: EngineTrio, reason: "user" | "normalize") => void;
	/** The providers this machine can run (useConfiguredProviders). */
	providers: ConfiguredProvider[];
	/** Prefix for the field ids, so several pickers can share a form. */
	idPrefix: string;
	disabled?: boolean;
	className?: string;
	/** Report whether the model is a real, resumable choice (not loading, not the sentinel). */
	onReadyChange?: (ready: boolean) => void;
}

/**
 * Provider × LLM × Effort, three selects.
 *
 * The one picker of a task's engine — at creation, in the edit dialog, per
 * phase, and when a paused task is resumed on something else. The model list
 * is the provider's own catalogue (`useProviderModelCatalog`), and a model
 * that belongs to another provider is brought back into it before it reaches
 * the task: asking Ollama for `claude-opus-4-8` fails at the call, with a
 * message about an unknown model rather than about the choice.
 *
 * "Autre (catalogue officiel)" is a door, not a model: it opens the official
 * library search, so the id that lands here is one a server can serve.
 */
export function EngineTrioPicker({
	value,
	onChange,
	providers,
	idPrefix,
	disabled = false,
	className,
	onReadyChange,
}: EngineTrioPickerProps) {
	const { t } = useTranslation(["tasks"]);
	const codexMode = useSettingsStore(
		(s) => s.settings.globalOpenAIAuthMode === "codex-cli",
	);
	const [searchingModel, setSearchingModel] = useState(false);

	const { models, loading: catalogLoading } = useProviderModelCatalog(
		value.provider,
	);
	const local = isLocalProvider(value.provider);
	// Keep custom/local IDs, but never inject a known foreign model into this
	// provider's picker. Codex's account inventory is authoritative.
	const effectiveModel =
		value.model &&
		!isCustomModelSentinel(value.model) &&
		!local &&
		(getModelTier(value.model) || (value.provider === "openai" && codexMode))
			? resolveModelForProviderCatalog(
					value.model.trim(),
					models,
					value.provider,
				)
			: value.model.trim();
	const { options: modelOptions, value: modelValue } = buildModelSelectOptions(
		models,
		effectiveModel,
		{},
		local,
	);

	// A task saved on the sentinel opens the search on its own: re-picking the
	// row it already shows fires no change.
	const stuckOnSentinel = isCustomModelSentinel(value.model);
	useEffect(() => {
		if (stuckOnSentinel) setSearchingModel(true);
	}, [stuckOnSentinel]);

	// The task records the model the provider will be asked for: an empty
	// model takes the catalogue's first, a foreign one its equivalent here.
	// Discovery must never erase the current model while it loads.
	useEffect(() => {
		if (catalogLoading) return;
		if (!value.model && models.length) {
			onChange({ ...value, model: models[0].value }, "normalize");
		} else if (
			effectiveModel &&
			effectiveModel !== value.model &&
			!isCustomModelSentinel(value.model)
		) {
			onChange({ ...value, model: effectiveModel }, "normalize");
		}
	}, [catalogLoading, models, value, effectiveModel, onChange]);

	const ready =
		!catalogLoading &&
		Boolean(effectiveModel) &&
		!isCustomModelSentinel(effectiveModel);
	useEffect(() => {
		onReadyChange?.(ready);
	}, [ready, onReadyChange]);

	const configured = providers.some((p) => p.name === value.provider);
	const providerOptions = configured
		? providers
		: [
				...providers,
				{
					name: value.provider,
					label: t("tasks:engine.notConfiguredOption", {
						provider: value.provider,
					}),
				},
			];

	return (
		<div className={cn("space-y-2", className)}>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
				<div className="min-w-0 space-y-1">
					<label
						htmlFor={`${idPrefix}-provider`}
						className="text-xs font-medium text-muted-foreground"
					>
						{t("tasks:modal.actions.chooseProvider")}
					</label>
					<Select
						value={value.provider}
						disabled={disabled}
						onValueChange={(provider) => {
							setSearchingModel(false);
							onChange({ ...value, provider, model: "" }, "user");
						}}
					>
						<SelectTrigger id={`${idPrefix}-provider`} className="h-8">
							<SelectValue />
						</SelectTrigger>
						<SelectContent searchable>
							{providerOptions.map((p) => (
								<SelectItem key={p.name} value={p.name}>
									{p.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="min-w-0 space-y-1">
					<label
						htmlFor={`${idPrefix}-model`}
						className="text-xs font-medium text-muted-foreground"
					>
						{t("tasks:modal.actions.chooseModel")}
					</label>
					<Select
						value={modelValue}
						disabled={disabled || modelOptions.length === 0}
						onValueChange={(model) => {
							if (isCustomModelSentinel(model)) {
								setSearchingModel(true);
								return;
							}
							onChange({ ...value, model }, "user");
						}}
					>
						<SelectTrigger id={`${idPrefix}-model`} className="h-8">
							<SelectValue
								placeholder={t("tasks:engine.loadingModels")}
							/>
						</SelectTrigger>
						<SelectContent searchable>
							{modelOptions.map((m) => (
								<SelectItem key={m.value} value={m.value}>
									{isCustomModelSentinel(m.value)
										? t("tasks:logs.model.customOption")
										: m.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{searchingModel && (
						<OfficialModelSearch
							onClose={() => setSearchingModel(false)}
							onSelect={(model) => {
								setSearchingModel(false);
								onChange({ ...value, model }, "user");
							}}
						/>
					)}
				</div>

				<div className="min-w-0 space-y-1">
					<label
						htmlFor={`${idPrefix}-effort`}
						className="text-xs font-medium text-muted-foreground"
					>
						{t("tasks:modal.actions.chooseEffort")}
					</label>
					<Select
						value={value.effort}
						disabled={disabled}
						onValueChange={(effort) =>
							onChange({ ...value, effort: effort as ThinkingLevel }, "user")
						}
					>
						<SelectTrigger id={`${idPrefix}-effort`} className="h-8">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{THINKING_LEVELS.map((level) => (
								<SelectItem key={level.value} value={level.value}>
									{level.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{!configured && providers.length > 0 && (
				<p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
					<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<span>
						{t("tasks:engine.notConfiguredWarning", {
							provider: value.provider,
						})}
					</span>
				</p>
			)}
		</div>
	);
}
