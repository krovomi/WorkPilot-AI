/**
 * #3.1 Adaptive Model Routing panel.
 *
 * Type a prompt + optional task class hint, see (a) the chosen model
 * and (b) a "what would it cost on each tier" comparison table.
 */

import type { TFunction } from "i18next";
import { ChevronDown, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { formatCurrency } from "../../lib/currency";
import type { ModelChoice } from "../../../preload/api/modules/phase35-features-api";
import { useModelRouterStore } from "../../stores/phase35-stores";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { PanelShell } from "./_panel-shell";
import { useEurRate } from "./_use-eur-rate";

import { NativeSelect } from "../ui/native-select";
import { Textarea } from "../ui/textarea";

/** The providers the backend router knows (`model_router.router.ROUTABLE_PROVIDERS`). */
const PROVIDER_OPTIONS = [
	{ value: "anthropic", labelKey: "modelRouter.providerAnthropic" },
	{ value: "openai", labelKey: "modelRouter.providerOpenai" },
	{ value: "google", labelKey: "modelRouter.providerGoogle" },
	{ value: "mistral", labelKey: "modelRouter.providerMistral" },
	{ value: "deepseek", labelKey: "modelRouter.providerDeepseek" },
	{ value: "grok", labelKey: "modelRouter.providerGrok" },
	{ value: "copilot", labelKey: "modelRouter.providerCopilot" },
	{ value: "ollama", labelKey: "modelRouter.providerOllama" },
] as const;

/** `model_router.router.TaskClass`; empty lets the router read the prompt. */
const TASK_CLASSES = [
	"trivial",
	"simple_edit",
	"multi_file",
	"architecture",
	"review",
	"planning",
	"ideation",
	"documentation",
] as const;

const PROMPT_MAX_LEN = 4000;

/** A provider's name, or its id when the router answers with one the panel does not list. */
function providerLabel(value: string, t: TFunction): string {
	const opt = PROVIDER_OPTIONS.find((o) => o.value === value);
	return opt ? t(opt.labelKey as never) : value;
}

/** Why the router chose this model, in the app language, from its reason code. */
function RouteReason({ choice }: { choice: ModelChoice }) {
	const { t } = useTranslation("phase35");
	const params = choice.reason_params ?? {};
	const provider = providerLabel(String(params.provider ?? choice.provider), t);
	const tier = t(`modelRouter.tiers.${choice.tier}` as never, { defaultValue: choice.tier });
	const task = t(`modelRouter.taskClasses.${choice.task_class}` as never, {
		defaultValue: choice.task_class,
	});
	const lines: string[] = [];
	switch (choice.reason_code) {
		case "unpriced_provider":
			lines.push(
				params.billing === "local"
					? t("modelRouter.reasons.local", { provider })
					: t("modelRouter.reasons.subscription", { provider }),
			);
			break;
		case "no_model":
			lines.push(
				t("modelRouter.reasons.noModel", {
					providers: Array.isArray(params.providers)
						? params.providers.map((p) => providerLabel(String(p), t)).join(", ")
						: provider,
				}),
			);
			break;
		case "fallback":
			lines.push(t("modelRouter.reasons.fallback"));
			break;
		case "tier_for_task":
			lines.push(t("modelRouter.tierFor", { tier, task }));
			break;
		default:
			lines.push(choice.reason);
	}
	if (typeof params.bench_resolved === "number" && typeof params.bench_judged === "number") {
		lines.push(
			t("modelRouter.reasons.bench", {
				resolved: params.bench_resolved,
				judged: params.bench_judged,
			}),
		);
	}
	if (Array.isArray(params.passed_over) && params.passed_over.length > 0) {
		lines.push(t("modelRouter.reasons.passedOver", { models: params.passed_over.join(", ") }));
	}
	return (
		<div className="text-xs text-muted-foreground">
			{t("modelRouter.reason")}: {lines.join(" ")}
		</div>
	);
}

export function ModelRouterPanel() {
	const { t, i18n } = useTranslation("phase35");
	const { phase, error, chosen, comparison, route, compare } = useModelRouterStore(
		useShallow((s) => ({
			phase: s.phase,
			error: s.error,
			chosen: s.chosen,
			comparison: s.comparison,
			route: s.route,
			compare: s.compare,
		})),
	);
	const [prompt, setPrompt] = useState("");
	const [hint, setHint] = useState("");
	const [providers, setProviders] = useState<string[]>(["anthropic"]);
	const [popoverOpen, setPopoverOpen] = useState(false);
	const eurRate = useEurRate(i18n.language);


	const isRunning = phase === "running";

	// The box cuts the prompt at PROMPT_MAX_LEN as it is typed: only an empty one is refused.
	const promptError = prompt.trim().length === 0 ? t("modelRouter.validation.promptRequired") : null;
	const providersError =
		providers.length === 0 ? t("modelRouter.validation.providersRequired") : null;

	const hasValidationError = Boolean(promptError) || Boolean(providersError);

	const buildReq = () => ({
		prompt: prompt.trim(),
		hint: hint.trim() || undefined,
		available: [...providers],
	});

	const toggleProvider = (value: string) => {
		setProviders((prev) =>
			prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value],
		);
	};

	const selectAll = () => setProviders(PROVIDER_OPTIONS.map((p) => p.value));
	const clearAll = () => setProviders([]);

	const triggerLabel =
		providers.length === 0
			? t("modelRouter.providersPlaceholder")
			: providers.length === PROVIDER_OPTIONS.length
				? t("common.selectAll")
				: t("common.selected", { count: providers.length });

	return (
		<PanelShell
			title={t("modelRouter.title")}
			subtitle={t("modelRouter.subtitle")}
			error={error}
			actions={
				<>
					<Button
						size="sm"
						onClick={() => route(buildReq())}
						disabled={isRunning || hasValidationError}
					>
						{isRunning ? t("common.running") : t("common.run")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => compare(buildReq())}
						disabled={isRunning || hasValidationError}
					>
						{t("modelRouter.compare")}
					</Button>
				</>
			}
		>
			<div className="space-y-3">
				<div>
					<label htmlFor="prompt-input" className="block text-sm font-medium mb-1">
						{t("modelRouter.prompt")}
					</label>
					<Textarea
						spellCheck={false}
						id="prompt-input"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX_LEN))}
						rows={3}
						maxLength={PROMPT_MAX_LEN}
						aria-invalid={Boolean(promptError) || undefined}
						aria-describedby={promptError ? "prompt-error" : undefined}
						className="w-full p-2 text-sm font-mono min-h-0"
						placeholder={t("modelRouter.promptPlaceholder")}
					/>
					{promptError && (
						<p id="prompt-error" className="mt-1 text-xs text-destructive">
							{promptError}
						</p>
					)}
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label htmlFor="hint-input" className="block text-sm font-medium mb-1">
							{t("modelRouter.hint")}
						</label>
						<NativeSelect
							id="hint-input"
							value={hint}
							onChange={(e) => setHint(e.target.value)}
							className="w-full p-2 text-sm h-auto"
						>
							<option value="">{t("modelRouter.hintAuto")}</option>
							{TASK_CLASSES.map((tc) => (
								<option key={tc} value={tc}>
									{t(`modelRouter.taskClasses.${tc}` as never)}
								</option>
							))}
						</NativeSelect>
					</div>
					<div>
						<div className="block text-sm font-medium mb-1">
							{t("modelRouter.availableProviders")}
						</div>
						<Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
							<PopoverTrigger asChild>
								<button
									type="button"
									aria-haspopup="listbox"
									aria-expanded={popoverOpen}
									aria-invalid={Boolean(providersError) || undefined}
									aria-describedby={providersError ? "providers-error" : undefined}
									className="flex h-10 w-full items-center justify-between rounded border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
								>
									<span
										className={
											providers.length === 0
												? "text-muted-foreground truncate"
												: "truncate"
										}
									>
										{triggerLabel}
									</span>
									<ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
								</button>
							</PopoverTrigger>
							<PopoverContent
								className="w-(--radix-popover-trigger-width) p-2"
								align="start"
							>
								<div className="flex items-center justify-between gap-2 border-b pb-2 mb-2">
									<button
										type="button"
										onClick={selectAll}
										className="text-xs underline-offset-2 hover:underline"
									>
										{t("common.selectAll")}
									</button>
									<button
										type="button"
										onClick={clearAll}
										className="text-xs underline-offset-2 hover:underline"
									>
										{t("common.clearAll")}
									</button>
								</div>
								<ul className="space-y-1" aria-label={t("modelRouter.availableProviders")}>
									{PROVIDER_OPTIONS.map((opt) => {
										const checked = providers.includes(opt.value);
										return (
											<li key={opt.value}>
												{/* Checkbox renders a button, not a native input, so
												    the label needs an explicit target. */}
												<label
													htmlFor={`provider-${opt.value}`}
													className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent cursor-pointer"
												>
													<Checkbox
														id={`provider-${opt.value}`}
														checked={checked}
														onCheckedChange={() => toggleProvider(opt.value)}
													/>
													<span>{t(opt.labelKey as never)}</span>
												</label>
											</li>
										);
									})}
								</ul>
							</PopoverContent>
						</Popover>
						{providers.length > 0 && (
							<div className="mt-2 flex flex-wrap gap-1">
								{providers.map((p) => {
									const label = providerLabel(p, t);
									return (
										<Badge
											key={p}
											variant="outline"
											className="gap-1 pr-1 text-xs"
										>
											{label}
											<button
												type="button"
												aria-label={t("modelRouter.removeProvider", { provider: label })}
												onClick={() => toggleProvider(p)}
												className="rounded p-0.5 hover:bg-muted"
											>
												<X className="h-3 w-3" />
											</button>
										</Badge>
									);
								})}
							</div>
						)}
						{providersError && (
							<p id="providers-error" className="mt-1 text-xs text-destructive">
								{providersError}
							</p>
						)}
					</div>
				</div>

				{chosen && (
					<div className="rounded border p-3 text-sm space-y-1">
						<div>
							<span className="font-medium">{t("modelRouter.chosen")}: </span>
							<Badge variant="outline">{providerLabel(chosen.provider, t)}</Badge>{" "}
							{chosen.model ? <code>{chosen.model}</code> : t("modelRouter.noModel")} (
							{t(`modelRouter.tiers.${chosen.tier}` as never, { defaultValue: chosen.tier })} ·{" "}
							{t(`modelRouter.taskClasses.${chosen.task_class}` as never, {
								defaultValue: chosen.task_class,
							})}
							)
						</div>
						<div className="text-muted-foreground">
							{t("modelRouter.estimatedCost")}:{" "}
							{formatCurrency(
								chosen.estimated_cost_usd,
								i18n.language,
								eurRate,
								6,
							)}
						</div>
						<RouteReason choice={chosen} />
					</div>
				)}

				{comparison && (
					<table className="w-full text-sm border">
						<thead>
							<tr className="border-b bg-muted/40">
								<th className="text-left p-2">{t("modelRouter.colTier")}</th>
								<th className="text-left p-2">{t("modelRouter.colModel")}</th>
								<th className="text-right p-2">{t("modelRouter.colCost")}</th>
							</tr>
						</thead>
						<tbody>
							{Object.entries(comparison).map(([tier, c]) => (
								<tr key={tier} className="border-b">
									<td className="p-2">
										{t(`modelRouter.tiers.${tier}` as never, { defaultValue: tier })}
									</td>
									<td className="p-2 font-mono">
										{c.model
											? `${providerLabel(c.provider, t)} · ${c.model}`
											: t("modelRouter.noModel")}
									</td>
									<td className="p-2 text-right font-mono">
										{formatCurrency(
											c.estimated_cost_usd,
											i18n.language,
											eurRate,
											6,
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		</PanelShell>
	);
}
