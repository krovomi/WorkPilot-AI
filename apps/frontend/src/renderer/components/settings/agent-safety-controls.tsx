/**
 * The controls the Sandbox and Anomaly detection pages share: reading and
 * changing `settings.agentSafety` (normalized, so what is shown is what the
 * backend will apply), a range row and a switch row.
 */

import type { ReactNode } from "react";
import type { AgentSafetySettings, AppSettings } from "../../../shared/types";
import { normalizeAgentSafety } from "../../../shared/utils/agent-safety";
import { Switch } from "../ui/switch";

export interface AgentSafetyPageProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
}

/** The current values and a setter for one section. */
export function useAgentSafety({ settings, onSettingsChange }: AgentSafetyPageProps) {
	const safety = normalizeAgentSafety(settings.agentSafety);
	function update<K extends keyof AgentSafetySettings>(
		section: K,
		patch: Partial<AgentSafetySettings[K]>,
	) {
		onSettingsChange({
			...settings,
			agentSafety: normalizeAgentSafety({
				...safety,
				[section]: { ...safety[section], ...patch },
			}),
		});
	}
	return { safety, update };
}

export function RangeRow({
	id,
	label,
	hint,
	value,
	display,
	min,
	max,
	step,
	onChange,
	accent = "accent-primary",
}: {
	readonly id: string;
	readonly label: string;
	readonly hint?: string;
	readonly value: number;
	readonly display?: string;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly onChange: (value: number) => void;
	readonly accent?: string;
}) {
	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between">
				<label htmlFor={id} className="text-xs font-medium text-muted-foreground">
					{label}
				</label>
				<span className="text-xs font-mono tabular-nums text-foreground">
					{display ?? value}
				</span>
			</div>
			<input
				id={id}
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className={`w-full ${accent}`}
			/>
			{hint && <p className="text-3xs text-muted-foreground">{hint}</p>}
		</div>
	);
}

export function SwitchRow({
	id,
	icon,
	title,
	description,
	checked,
	onChange,
}: {
	readonly id: string;
	readonly icon: ReactNode;
	readonly title: string;
	readonly description: string;
	readonly checked: boolean;
	readonly onChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
			<div className="flex items-center gap-3">
				{icon}
				<div>
					<label htmlFor={id} className="text-sm font-medium">
						{title}
					</label>
					<p className="text-xs text-muted-foreground">{description}</p>
				</div>
			</div>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</div>
	);
}
