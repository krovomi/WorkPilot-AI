import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	SCROLLBACK_MAX,
	SCROLLBACK_MIN,
	SCROLLBACK_STEP,
} from "../../../lib/terminal-font-constants";
import { cn } from "../../../lib/utils";
import type { TerminalFontSettings } from "../../../stores/terminal-font-settings-store";
import { Label } from "../../ui/label";
import { SliderField } from "./SliderField";

interface PerformanceConfigPanelProps {
	settings: TerminalFontSettings;
	onSettingChange: <K extends keyof TerminalFontSettings>(
		key: K,
		value: TerminalFontSettings[K],
	) => void;
}

/**
 * Performance configuration panel for terminal scrollback settings.
 * Provides controls for:
 * - Quick preset buttons (1K, 10K, 50K, 100K lines)
 * - Fine-tune slider (1K-100K lines in 1K increments)
 *
 * All changes apply immediately and persist via the parent store
 */
export function PerformanceConfigPanel({
	settings,
	onSettingChange,
}: PerformanceConfigPanelProps) {
	const { t } = useTranslation("settings");

	// Format scrollback value for display (e.g., 10000 -> "10K")
	const formatScrollback = (value: number): string => {
		if (value >= 1000) {
			return t("terminalFonts.performanceConfig.kValue", {
				defaultValue: "{{value}}K",
				value: value / 1000,
			});
		}
		return value.toString();
	};

	// Preset scrollback values with labels (defined inside component to access t())
	const scrollbackPresets = [
		{
			value: 1000,
			label: formatScrollback(1000),
			description: t("terminalFonts.performanceConfig.presetMinimal", {
				defaultValue: "Minimal",
			}),
		},
		{
			value: 10000,
			label: formatScrollback(10000),
			description: t("terminalFonts.performanceConfig.presetStandard", {
				defaultValue: "Standard",
			}),
		},
		{
			value: 50000,
			label: formatScrollback(50000),
			description: t("terminalFonts.performanceConfig.presetExtended", {
				defaultValue: "Extended",
			}),
		},
		{
			value: 100000,
			label: formatScrollback(100000),
			description: t("terminalFonts.performanceConfig.presetMaximum", {
				defaultValue: "Maximum",
			}),
		},
	] as const;

	// Handle scrollback change
	const handleScrollbackChange = (value: number) => {
		if (Number.isNaN(value)) return;
		const clampedValue = Math.max(
			SCROLLBACK_MIN,
			Math.min(SCROLLBACK_MAX, value),
		);
		// Round to nearest 1K
		const steppedValue =
			Math.round(clampedValue / SCROLLBACK_STEP) * SCROLLBACK_STEP;
		onSettingChange("scrollback", steppedValue);
	};

	// Handle preset button clicks - apply immediately
	const handlePresetChange = (newScrollback: number) => {
		onSettingChange("scrollback", newScrollback);
	};

	return (
		<div className="space-y-6">
			{/* Preset Buttons */}
			<div className="space-y-2.5">
				<Label className="flex items-center gap-2 text-sm font-medium text-foreground">
					<Zap className="h-4 w-4 text-muted-foreground" />
					{t("terminalFonts.performanceConfig.presets", {
						defaultValue: "Quick Presets",
					})}
				</Label>
				<p className="text-xs leading-relaxed text-muted-foreground">
					{t("terminalFonts.performanceConfig.presetsDescription", {
						defaultValue: "Common scrollback limits for different use cases",
					})}
				</p>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
					{scrollbackPresets.map((preset) => {
						const isSelected = settings.scrollback === preset.value;
						return (
							<button
								type="button"
								key={preset.value}
								onClick={() => handlePresetChange(preset.value)}
								aria-pressed={isSelected}
								className={cn(
									"rounded-lg border px-2 py-2.5 text-center transition-all",
									"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
									isSelected
										? "border-primary bg-primary/10 text-foreground"
										: "border-border hover:border-primary/50 hover:bg-accent/50",
								)}
							>
								<div className="font-mono text-sm font-medium tabular-nums">
									{preset.label}
								</div>
								<div className="truncate text-[11px] text-muted-foreground">
									{preset.description}
								</div>
							</button>
						);
					})}
				</div>
			</div>

			{/* Fine-tune Slider */}
			<SliderField
				label={t("terminalFonts.performanceConfig.scrollback", {
					defaultValue: "Scrollback Limit",
				})}
				description={t("terminalFonts.performanceConfig.scrollbackDescription", {
					defaultValue:
						"Maximum number of lines to keep in terminal history (1K-100K)",
				})}
				valueLabel={formatScrollback(settings.scrollback)}
				value={settings.scrollback}
				min={SCROLLBACK_MIN}
				max={SCROLLBACK_MAX}
				step={SCROLLBACK_STEP}
				minLabel={formatScrollback(SCROLLBACK_MIN)}
				maxLabel={formatScrollback(SCROLLBACK_MAX)}
				ariaValueText={t("terminalFonts.performanceConfig.scrollbackValue", {
					defaultValue: "{{value}} lines",
					value: formatScrollback(settings.scrollback),
				})}
				onChange={handleScrollbackChange}
				stepper={{
					onDecrease: () =>
						handleScrollbackChange(settings.scrollback - SCROLLBACK_STEP),
					onIncrease: () =>
						handleScrollbackChange(settings.scrollback + SCROLLBACK_STEP),
					decreaseTitle: t("terminalFonts.performanceConfig.decreaseScrollback", {
						step: formatScrollback(SCROLLBACK_STEP),
					}),
					increaseTitle: t("terminalFonts.performanceConfig.increaseScrollback", {
						step: formatScrollback(SCROLLBACK_STEP),
					}),
					decreaseDisabled: settings.scrollback <= SCROLLBACK_MIN,
					increaseDisabled: settings.scrollback >= SCROLLBACK_MAX,
				}}
			/>
		</div>
	);
}
