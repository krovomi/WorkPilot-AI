/**
 * ContextPolicyFields — per-task context-window management.
 *
 * What the backend does when the agent session's context window reaches the
 * threshold: compact (summarise, same thread), clear (fresh thread seeded with
 * the handoff), auto (it picks) or off. Persisted as `contextPolicy` in
 * task_metadata.json and re-read live by the backend.
 *
 * `ContextPolicyControls` is the bare set of controls, reused by the live
 * gauge's popover (task-detail/ContextGauge); `ContextPolicyFields` wraps it in
 * the collapsible card of the creation / edit forms.
 */

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ChevronDown, ChevronUp, Layers } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { providerRegistry } from "../../../shared/services/providerRegistry";
import type { ContextPolicy, ContextPolicyMode } from "../../../shared/types";
import {
	CONTEXT_POLICY_MODES,
	CONTEXT_THRESHOLD_MAX,
	CONTEXT_THRESHOLD_MIN,
	CONTEXT_THRESHOLD_STEP,
	normalizeThreshold,
} from "../../../shared/utils/context-policy";
import { useAgenticCapabilities } from "../../hooks/useAgenticCapabilities";
import { cn } from "../../lib/utils";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

interface ContextPolicyControlsProps {
	value: ContextPolicy;
	onChange: (policy: ContextPolicy) => void;
	disabled?: boolean;
	idPrefix?: string;
	/** Smaller paddings for the popover. */
	dense?: boolean;
}

export function ContextPolicyControls({
	value,
	onChange,
	disabled = false,
	idPrefix = "",
	dense = false,
}: ContextPolicyControlsProps) {
	const { t } = useTranslation(["tasks"]);
	const prefix = idPrefix ? `${idPrefix}-` : "";
	const thresholdId = `${prefix}context-threshold`;
	const handoffId = `${prefix}context-handoff`;
	const handoffDisabled = disabled || value.mode === "off";

	return (
		<div className={cn("space-y-3", dense && "space-y-2.5")}>
			<div className="space-y-1.5">
				<span className="text-xs font-medium text-foreground">
					{t("tasks:contextManagement.modeLabel")}
				</span>
				<RadioGroupPrimitive.Root
					value={value.mode}
					onValueChange={(mode) =>
						onChange({ ...value, mode: mode as ContextPolicyMode })
					}
					disabled={disabled}
					orientation="horizontal"
					aria-label={t("tasks:contextManagement.modeLabel")}
					className="grid grid-cols-4 gap-0.5 rounded-md border border-border bg-muted/40 p-0.5"
				>
					{CONTEXT_POLICY_MODES.map((mode) => (
						<RadioGroupPrimitive.Item
							key={mode}
							value={mode}
							className={cn(
								"rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors",
								"hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								"disabled:cursor-not-allowed disabled:opacity-50",
								"data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm",
							)}
						>
							{t(`tasks:contextManagement.modes.${mode}`)}
						</RadioGroupPrimitive.Item>
					))}
				</RadioGroupPrimitive.Root>
				<p className="text-[11px] leading-snug text-muted-foreground">
					{t(`tasks:contextManagement.modeHints.${value.mode}`)}
				</p>
			</div>

			<div className="space-y-1">
				<div className="flex items-center justify-between">
					<Label htmlFor={thresholdId} className="text-xs font-medium">
						{t("tasks:contextManagement.threshold.label")}
					</Label>
					<span className="text-xs font-semibold tabular-nums text-foreground">
						{t("tasks:contextManagement.threshold.value", {
							value: value.thresholdPct,
						})}
					</span>
				</div>
				<input
					id={thresholdId}
					type="range"
					min={CONTEXT_THRESHOLD_MIN}
					max={CONTEXT_THRESHOLD_MAX}
					step={CONTEXT_THRESHOLD_STEP}
					value={value.thresholdPct}
					disabled={disabled || value.mode === "off"}
					onChange={(event) =>
						onChange({
							...value,
							thresholdPct: normalizeThreshold(event.target.value),
						})
					}
					aria-valuetext={t("tasks:contextManagement.threshold.value", {
						value: value.thresholdPct,
					})}
					className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gradient-to-r from-success/60 via-warning/60 to-destructive/60 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
				/>
				<div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
					<span>{CONTEXT_THRESHOLD_MIN}%</span>
					<span>{CONTEXT_THRESHOLD_MAX}%</span>
				</div>
			</div>

			<div className="flex items-start justify-between gap-3">
				<div className="space-y-0.5">
					<Label htmlFor={handoffId} className="text-xs font-medium">
						{t("tasks:contextManagement.prepareHandoff.label")}
					</Label>
					{!dense && (
						<p className="text-[11px] leading-snug text-muted-foreground">
							{t("tasks:contextManagement.prepareHandoff.hint")}
						</p>
					)}
				</div>
				<Switch
					id={handoffId}
					checked={value.prepareHandoff}
					disabled={handoffDisabled}
					onCheckedChange={(checked) =>
						onChange({ ...value, prepareHandoff: checked === true })
					}
				/>
			</div>
		</div>
	);
}

/**
 * "Claude: native compaction" / "Ollama: compaction emulated by summary",
 * from the served capability matrix. Renders nothing when it is unknown.
 */
export function ContextProviderHint({
	provider,
	className,
}: {
	provider?: string | null;
	className?: string;
}) {
	const { t } = useTranslation(["tasks"]);
	const { contextCompact } = useAgenticCapabilities();
	if (!provider) return null;
	const support = contextCompact(provider);
	if (!support) return null;
	const label = providerRegistry.getProvider(provider)?.label ?? provider;
	return (
		<p
			className={cn("text-[11px] text-muted-foreground", className)}
			data-testid="context-provider-hint"
		>
			{t(`tasks:contextManagement.provider.${support}`, { provider: label })}
		</p>
	);
}

interface ContextPolicyFieldsProps {
	value: ContextPolicy;
	onChange: (policy: ContextPolicy) => void;
	/** The provider of the coding phase, for the native / emulated hint. */
	provider?: string | null;
	disabled?: boolean;
	idPrefix?: string;
	/** Open the card on first render. */
	defaultOpen?: boolean;
}

export function ContextPolicyFields({
	value,
	onChange,
	provider,
	disabled = false,
	idPrefix = "",
	defaultOpen = false,
}: ContextPolicyFieldsProps) {
	const { t } = useTranslation(["tasks"]);
	const [open, setOpen] = useState(defaultOpen);
	const summary =
		value.mode === "off"
			? t("tasks:contextManagement.summaryOff")
			: t("tasks:contextManagement.summary", {
					mode: t(`tasks:contextManagement.modes.${value.mode}`),
					threshold: value.thresholdPct,
				});

	return (
		<div className="rounded-lg border border-border bg-muted/30">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-label={t("tasks:contextManagement.toggle")}
				className="flex w-full items-start gap-3 p-4 text-left"
			>
				<Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
				<div className="flex-1 space-y-1">
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-medium text-foreground">
							{t("tasks:contextManagement.title")}
						</span>
						<span className="text-xs text-muted-foreground tabular-nums">
							{summary}
						</span>
					</div>
					<p className="text-xs text-muted-foreground">
						{t("tasks:contextManagement.description")}
					</p>
				</div>
				{open ? (
					<ChevronUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
				) : (
					<ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
				)}
			</button>
			{open && (
				<div className="space-y-2 border-t border-border px-4 pb-4 pt-3">
					<ContextPolicyControls
						value={value}
						onChange={onChange}
						disabled={disabled}
						idPrefix={idPrefix}
					/>
					<ContextProviderHint provider={provider} />
				</div>
			)}
		</div>
	);
}
