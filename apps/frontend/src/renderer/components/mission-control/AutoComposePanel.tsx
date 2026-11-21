/**
 * Auto-compose (#344): describe the work, pick a spec or a template, choose
 * the providers to mix and a budget; Mission Control suggests a crew and, when
 * it does not fit, a cheaper one with what it saves and the quality it keeps.
 *
 * The suggestion is the backend's (`mission_control/composition.py`), reached
 * through the main process, which resolves the project and runs the optional
 * fast model. Nothing is created until the person applies the crew.
 */

import { AlertTriangle, Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { providerRegistry } from "../../../shared/services/providerRegistry";
import type {
	MissionControlComposition,
	MissionControlCompositionRequest,
	MissionControlCrew,
	MissionControlPlannedAgent,
	MissionControlPlanRequest,
} from "../../../shared/types/mission-control";
import { useProjectStore } from "../../stores/project-store";
import { useTaskStore } from "../../stores/task-store";
import { CharterButton, Chip, Chips, Notice } from "../charter";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { Textarea } from "../ui/textarea";
import { SessionTemplates, type TemplateChoice } from "./SessionTemplates";

const PROVIDERS = providerRegistry
	.getAllProviders()
	.map((p) => ({ value: p.name, label: p.label }));

const providerLabel = (name: string) =>
	PROVIDERS.find((p) => p.value === name)?.label ?? name;

/** The refusals the page words itself; anything else is shown as received. */
const KNOWN_ERRORS = new Set([
	"invalid_request",
	"invalid_providers",
	"unknown_template",
	"invalid_budget",
	"invalid_project",
	"invalid_spec",
	"no_provider",
	"no_capable_model",
]);

type BudgetUnit = "usd" | "tokens";

interface AutoComposePanelProps {
	/** The provider the dialog had selected: the first of the mix. */
	readonly defaultProvider: string;
	/** `plan`: the providers and budget the crew was composed on, for the session. */
	readonly onApply: (
		agents: MissionControlPlannedAgent[],
		plan: MissionControlPlanRequest,
	) => Promise<void>;
}

/** The budget field as the request wants it, or null when it is not a number. */
function budgetOf(
	raw: string,
	unit: BudgetUnit,
): Pick<MissionControlCompositionRequest, "budgetUsd" | "budgetTokens"> | null {
	if (!raw.trim()) return {};
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return null;
	return unit === "usd" ? { budgetUsd: value } : { budgetTokens: Math.round(value) };
}

export function AutoComposePanel({ defaultProvider, onApply }: AutoComposePanelProps) {
	const { t, i18n } = useTranslation("missionControl");
	const projectId = useProjectStore((s) => s.selectedProjectId);
	const tasks = useTaskStore((s) => s.tasks);
	const [template, setTemplate] = useState<TemplateChoice>("auto");
	const [prompt, setPrompt] = useState("");
	const [specId, setSpecId] = useState("");
	const [providers, setProviders] = useState<string[]>([defaultProvider]);
	const [budget, setBudget] = useState("");
	const [unit, setUnit] = useState<BudgetUnit>("usd");
	const [refine, setRefine] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<MissionControlComposition | null>(null);

	const specs = tasks.filter((task) => task.projectId === projectId && task.specId);
	const usd = (value: number) => value.toFixed(4);
	const count = (value: number) => value.toLocaleString(i18n.language);
	const roleLabel = (role: string) => t(`roles.${role}`);
	const agentModel = (agent: MissionControlPlannedAgent) =>
		agent.model_label || t("compose.providerDefault");

	const toggleProvider = (name: string) =>
		setProviders((current) =>
			current.includes(name) ? current.filter((p) => p !== name) : [...current, name],
		);

	const suggest = async () => {
		const budgetFields = budgetOf(budget, unit);
		if (!budgetFields) {
			setError("invalid_budget");
			return;
		}
		setBusy(true);
		setError(null);
		const res = await window.electronAPI.missionControlSuggestComposition({
			prompt,
			providers,
			refine,
			...(template === "auto" ? {} : { template }),
			...(projectId ? { projectId } : {}),
			...(specId ? { specId } : {}),
			...budgetFields,
		});
		setBusy(false);
		if (res.success && res.data) {
			setResult(res.data);
			return;
		}
		setResult(null);
		setError(res.error ?? "");
	};

	const crew: MissionControlCrew | null = result?.proposed ?? null;
	const calibrated = result?.calibrated ?? [];

	const apply = async (agents: MissionControlPlannedAgent[], budgetOfResult: MissionControlComposition["budget"]) => {
		setBusy(true);
		await onApply(agents, {
			providers,
			...(budgetOfResult.usd === null ? {} : { budgetUsd: budgetOfResult.usd }),
			...(budgetOfResult.tokens === null ? {} : { budgetTokens: budgetOfResult.tokens }),
		});
		setBusy(false);
	};

	return (
		<div className="space-y-4">
			<p className="wp-meta">{t("compose.intro")}</p>

			<div className="space-y-2">
				<Label className="text-xs">{t("compose.templatesLabel")}</Label>
				<SessionTemplates value={template} onChange={setTemplate} />
			</div>

			<div className="space-y-2">
				<Label htmlFor="mc-compose-prompt" className="text-xs">
					{t("compose.promptLabel")}
				</Label>
				<Textarea
					id="mc-compose-prompt"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder={t("compose.promptPlaceholder")}
					className="text-sm"
				/>
			</div>

			{specs.length > 0 && (
				<div className="space-y-2">
					<Label htmlFor="mc-compose-spec" className="text-xs">
						{t("compose.specLabel")}
					</Label>
					<NativeSelect
						id="mc-compose-spec"
						value={specId}
						onChange={(e) => setSpecId(e.target.value)}
						className="w-full"
					>
						<option value="">{t("compose.noSpec")}</option>
						{specs.map((task) => (
							<option key={task.id} value={task.specId}>
								{task.title}
							</option>
						))}
					</NativeSelect>
				</div>
			)}

			<div className="space-y-2">
				<Label className="text-xs">{t("compose.providersLabel")}</Label>
				<Chips>
					{PROVIDERS.map((p) => (
						<Chip
							key={p.value}
							dot={false}
							pressed={providers.includes(p.value)}
							onClick={() => toggleProvider(p.value)}
						>
							{p.label}
						</Chip>
					))}
				</Chips>
				<p className="wp-meta">{t("compose.providersHint")}</p>
				{providers.length > 0 && (
					<p className="wp-meta">
						{t("compose.providerOrder", { list: providers.map(providerLabel).join(" → ") })}
					</p>
				)}
			</div>

			<div className="space-y-2">
				<Label htmlFor="mc-compose-budget" className="text-xs">
					{t("compose.budgetLabel")}
				</Label>
				<div className="flex gap-2">
					<Input
						id="mc-compose-budget"
						inputMode="decimal"
						value={budget}
						onChange={(e) => setBudget(e.target.value)}
						placeholder={t("compose.budgetPlaceholder")}
						className="text-sm"
					/>
					<NativeSelect
						aria-label={t("compose.budgetLabel")}
						value={unit}
						onChange={(e) => setUnit(e.target.value as BudgetUnit)}
					>
						<option value="usd">{t("compose.budgetUnits.usd")}</option>
						<option value="tokens">{t("compose.budgetUnits.tokens")}</option>
					</NativeSelect>
				</div>
			</div>

			<div className="flex items-center gap-2">
				<Checkbox
					id="mc-compose-refine"
					checked={refine}
					onCheckedChange={(checked) => setRefine(checked === true)}
				/>
				<Label htmlFor="mc-compose-refine" className="text-xs">
					{t("compose.refine")}
				</Label>
			</div>

			<CharterButton
				icon={Wand2}
				busy={busy}
				disabled={busy || providers.length === 0}
				onClick={() => void suggest()}
			>
				{t("compose.suggest")}
			</CharterButton>

			{error !== null && (
				<Notice tone="red" icon={AlertTriangle} role="alert">
					{KNOWN_ERRORS.has(error)
						? t(`compose.errors.${error}`)
						: t("compose.errors.generic", { error })}
				</Notice>
			)}

			{result && (
				<div className="space-y-3" data-testid="mc-composition">
					<p className="wp-title text-sm">
						{t("compose.summary", {
							template: t(`compose.templates.${result.template}.label`),
							complexity: t(`compose.complexity.${result.complexity}`),
						})}
					</p>
					{result.warnings.map((w) => (
						<Notice key={`${w.code}-${JSON.stringify(w.params)}`} tone="orange" icon={AlertTriangle}>
							{t(`compose.warnings.${w.code}`, {
								...w.params,
								...(w.params.role ? { role: roleLabel(w.params.role) } : {}),
								...(w.params.provider ? { provider: providerLabel(w.params.provider) } : {}),
							})}
						</Notice>
					))}
					{result.status === "refused" && result.minimum && (
						<Notice tone="red" icon={AlertTriangle} role="alert">
							{t("compose.refused", {
								cost: usd(result.minimum.cost_usd),
								tokens: count(result.minimum.tokens),
							})}
						</Notice>
					)}
					{result.status === "degraded" && crew && (
						<Notice tone="blue" icon={Sparkles}>
							<p>
								{t("compose.degraded", {
									full: usd(result.full.cost_usd),
									proposed: usd(crew.cost_usd),
									delta: usd(result.full.cost_usd - crew.cost_usd),
									quality: Math.round(crew.quality * 100),
								})}
							</p>
							<ul className="mt-1 list-disc pl-4">
								{result.changes.map((c) => (
									<li key={c.key}>
										{c.kind === "dropped"
											? t("compose.changes.dropped", { role: roleLabel(c.role) })
											: t("compose.changes.model", {
													role: roleLabel(c.role),
													from: agentModel(c.from),
													to: agentModel(c.to),
												})}
									</li>
								))}
							</ul>
						</Notice>
					)}
					{crew && (
						<>
							<ul className="space-y-1.5">
								{crew.agents.map((agent) => (
									<li key={agent.key} className="flex flex-wrap items-center gap-2 text-sm">
										<span className="wp-title">{roleLabel(agent.role)}</span>
										<Chip tone="violet" dot={false}>
											{providerLabel(agent.provider)}
										</Chip>
										<span className="text-muted-foreground">{agentModel(agent)}</span>
										<Chip tone="blue" dot={false}>
											{t(`compose.tiers.${agent.tier}`)}
										</Chip>
										<span className="ml-auto wp-meta">
											{agent.cost_usd === null
												? t("compose.unpriced")
												: agent.flat_rate
													? t("compose.flatRate")
													: t("compose.cost", { value: usd(agent.cost_usd) })}
										</span>
									</li>
								))}
							</ul>
							<p className="wp-meta">
								{t("compose.total", { cost: usd(crew.cost_usd), tokens: count(crew.tokens) })}
							</p>
							{calibrated.length > 0 && (
								<p className="wp-meta" data-testid="mc-composition-calibrated">
									{t("compose.calibrated", { roles: calibrated.map(roleLabel).join(", ") })}
								</p>
							)}
							<p className="wp-meta">{t("compose.rebalanceHint")}</p>
							<CharterButton
								variant="primary"
								icon={Wand2}
								disabled={busy || crew.agents.length === 0}
								onClick={() => void apply(crew.agents, result.budget)}
							>
								{t("compose.apply", { count: crew.agents.length })}
							</CharterButton>
						</>
					)}
				</div>
			)}
		</div>
	);
}
