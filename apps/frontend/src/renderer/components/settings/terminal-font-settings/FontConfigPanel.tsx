import { Minus, Plus, Type } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { COMMON_MONOSPACE_FONTS } from "../../../lib/font-discovery";
import {
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	FONT_SIZE_STEP,
	FONT_WEIGHT_MAX,
	FONT_WEIGHT_MIN,
	FONT_WEIGHT_STEP,
	LETTER_SPACING_MAX,
	LETTER_SPACING_MIN,
	LETTER_SPACING_STEP,
	LINE_HEIGHT_MAX,
	LINE_HEIGHT_MIN,
	LINE_HEIGHT_STEP,
} from "../../../lib/terminal-font-constants";
import { cn } from "../../../lib/utils";
import type { TerminalFontSettings } from "../../../stores/terminal-font-settings-store";
import { Combobox, type ComboboxOption } from "../../ui/combobox";
import { Label } from "../../ui/label";
import { SliderField } from "./SliderField";

interface FontConfigPanelProps {
	settings: TerminalFontSettings;
	onSettingChange: <K extends keyof TerminalFontSettings>(
		key: K,
		value: TerminalFontSettings[K],
	) => void;
}

const STEPPER_BUTTON_CLASSES = cn(
	"inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors",
	"hover:bg-accent text-muted-foreground hover:text-foreground",
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	"disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent",
);

/**
 * Font configuration panel for terminal font customization.
 * Provides controls for:
 * - Font family (combobox with common monospace fonts)
 * - Font size (slider: 10-24px)
 * - Font weight (number input: 100-900)
 * - Line height (slider: 1.0-2.0)
 * - Letter spacing (slider: -2 to 5px)
 *
 * All changes apply immediately and persist via the parent store
 */
export function FontConfigPanel({
	settings,
	onSettingChange,
}: FontConfigPanelProps) {
	const { t, i18n } = useTranslation("settings");

	// Locale-aware number formatter for decimals
	const numberFormatter = useMemo(() => {
		return new Intl.NumberFormat(i18n.language, {
			minimumFractionDigits: 0,
			maximumFractionDigits: 1,
		});
	}, [i18n.language]);

	// State for available fonts (will be populated from font-discovery)
	const [availableFonts, setAvailableFonts] = useState<ComboboxOption[]>([]);

	// Load available fonts on mount
	useEffect(() => {
		// Combine all common monospace fonts
		const allFonts = [
			...COMMON_MONOSPACE_FONTS.windows,
			...COMMON_MONOSPACE_FONTS.macos,
			...COMMON_MONOSPACE_FONTS.linux,
			...COMMON_MONOSPACE_FONTS.popular,
		];

		// Remove duplicates and filter out 'monospace' generic
		const uniqueFonts = [...new Set(allFonts)].filter(
			(f) => f.toLowerCase() !== "monospace",
		);

		// Convert to Combobox options
		const fontOptions: ComboboxOption[] = uniqueFonts.map((font) => ({
			value: font,
			label: font,
		}));

		setAvailableFonts(fontOptions);
	}, []);

	// Current font family (primary font from the array)
	const currentFontFamily = settings.fontFamily[0] || "";

	// Handle font family change
	const handleFontFamilyChange = (fontFamily: string) => {
		// Replace the entire font chain with the selected font as primary
		// Keep 'monospace' as ultimate fallback
		const newFontChain = [fontFamily, "monospace"];
		onSettingChange("fontFamily", newFontChain);
	};

	// Handle font size change
	const handleFontSizeChange = (value: number) => {
		if (Number.isNaN(value)) return;
		const clampedValue = Math.max(
			FONT_SIZE_MIN,
			Math.min(FONT_SIZE_MAX, value),
		);
		onSettingChange("fontSize", clampedValue);
	};

	// Handle font weight change
	const handleFontWeightChange = (value: string) => {
		const numValue = parseInt(value, 10);
		if (Number.isNaN(numValue)) return;

		// Clamp to valid font weights (100-900, step of 100)
		const clampedValue = Math.max(
			FONT_WEIGHT_MIN,
			Math.min(FONT_WEIGHT_MAX, numValue),
		);
		const steppedValue =
			Math.round(clampedValue / FONT_WEIGHT_STEP) * FONT_WEIGHT_STEP;

		onSettingChange("fontWeight", steppedValue);
	};

	// Handle line height change
	const handleLineHeightChange = (value: number) => {
		if (Number.isNaN(value)) return;
		const clampedValue = Math.max(
			LINE_HEIGHT_MIN,
			Math.min(LINE_HEIGHT_MAX, value),
		);
		// Round to 1 decimal place
		const roundedValue = Math.round(clampedValue * 10) / 10;
		onSettingChange("lineHeight", roundedValue);
	};

	// Handle letter spacing change
	const handleLetterSpacingChange = (value: number) => {
		if (Number.isNaN(value)) return;
		const clampedValue = Math.max(
			LETTER_SPACING_MIN,
			Math.min(LETTER_SPACING_MAX, value),
		);
		// Round to 1 decimal place
		const roundedValue = Math.round(clampedValue * 10) / 10;
		onSettingChange("letterSpacing", roundedValue);
	};

	const letterSpacingLabel = `${
		settings.letterSpacing > 0
			? `+${numberFormatter.format(settings.letterSpacing)}`
			: numberFormatter.format(settings.letterSpacing)
	}px`;

	const pixelsLabel = t("terminalFonts.fontConfig.pixels", {
		defaultValue: "pixels",
	});

	return (
		<div className="space-y-6">
			{/* Font Family */}
			<div className="space-y-2.5">
				<Label className="flex items-center gap-2 text-sm font-medium text-foreground">
					<Type className="h-4 w-4 text-muted-foreground" />
					{t("terminalFonts.fontConfig.fontFamily", {
						defaultValue: "Font Family",
					})}
				</Label>
				<p className="text-xs leading-relaxed text-muted-foreground">
					{t("terminalFonts.fontConfig.fontFamilyDescription", {
						defaultValue: "Primary monospace font for terminal text",
					})}
				</p>
				<Combobox
					value={currentFontFamily}
					onValueChange={handleFontFamilyChange}
					options={availableFonts}
					placeholder={t("terminalFonts.fontConfig.selectFont", {
						defaultValue: "Select a font...",
					})}
					searchPlaceholder={t("terminalFonts.fontConfig.searchFont", {
						defaultValue: "Search fonts...",
					})}
					emptyMessage={t("terminalFonts.fontConfig.noFonts", {
						defaultValue: "No fonts found",
					})}
				/>
				{/* Current font chain display */}
				<p className="text-[11px] text-muted-foreground">
					{t("terminalFonts.fontConfig.fontChain", {
						defaultValue: "Font chain:",
					})}{" "}
					<span className="break-words font-mono text-foreground/80">
						{settings.fontFamily.join(", ")}
					</span>
				</p>
			</div>

			{/* Font Size */}
			<SliderField
				label={t("terminalFonts.fontConfig.fontSize", {
					defaultValue: "Font Size",
				})}
				description={t("terminalFonts.fontConfig.fontSizeDescription", {
					defaultValue: "Base font size in pixels (10-24px)",
				})}
				valueLabel={`${settings.fontSize}px`}
				value={settings.fontSize}
				min={FONT_SIZE_MIN}
				max={FONT_SIZE_MAX}
				step={FONT_SIZE_STEP}
				minLabel={`${FONT_SIZE_MIN}px`}
				maxLabel={`${FONT_SIZE_MAX}px`}
				ariaValueText={`${settings.fontSize} ${pixelsLabel}`}
				onChange={handleFontSizeChange}
				stepper={{
					onDecrease: () =>
						handleFontSizeChange(settings.fontSize - FONT_SIZE_STEP),
					onIncrease: () =>
						handleFontSizeChange(settings.fontSize + FONT_SIZE_STEP),
					decreaseTitle: t("terminalFonts.fontConfig.decreaseFontSize", {
						step: FONT_SIZE_STEP,
					}),
					increaseTitle: t("terminalFonts.fontConfig.increaseFontSize", {
						step: FONT_SIZE_STEP,
					}),
					decreaseDisabled: settings.fontSize <= FONT_SIZE_MIN,
					increaseDisabled: settings.fontSize >= FONT_SIZE_MAX,
				}}
			/>

			{/* Font Weight */}
			<div className="space-y-2.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Label className="text-sm font-medium text-foreground">
						{t("terminalFonts.fontConfig.fontWeight", {
							defaultValue: "Font Weight",
						})}
					</Label>
					<div className="flex items-center gap-1.5">
						<input
							type="number"
							min={FONT_WEIGHT_MIN}
							max={FONT_WEIGHT_MAX}
							step={FONT_WEIGHT_STEP}
							value={settings.fontWeight}
							onChange={(e) => handleFontWeightChange(e.target.value)}
							aria-label={t("terminalFonts.fontConfig.fontWeight", {
								defaultValue: "Font Weight",
							})}
							className={cn(
								"h-8 w-20 rounded-md px-2",
								"border border-border bg-background",
								"font-mono text-xs tabular-nums text-foreground",
								"focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary",
								"transition-colors duration-200",
							)}
						/>
						<div className="flex items-center gap-0.5">
							<button
								type="button"
								onClick={() =>
									handleFontWeightChange(
										(settings.fontWeight - FONT_WEIGHT_STEP).toString(),
									)
								}
								disabled={settings.fontWeight <= FONT_WEIGHT_MIN}
								className={STEPPER_BUTTON_CLASSES}
								title={t("terminalFonts.fontConfig.decreaseFontWeight", {
									step: FONT_WEIGHT_STEP,
								})}
							>
								<Minus className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								onClick={() =>
									handleFontWeightChange(
										(settings.fontWeight + FONT_WEIGHT_STEP).toString(),
									)
								}
								disabled={settings.fontWeight >= FONT_WEIGHT_MAX}
								className={STEPPER_BUTTON_CLASSES}
								title={t("terminalFonts.fontConfig.increaseFontWeight", {
									step: FONT_WEIGHT_STEP,
								})}
							>
								<Plus className="h-3.5 w-3.5" />
							</button>
						</div>
					</div>
				</div>
				<p className="text-xs leading-relaxed text-muted-foreground">
					{t("terminalFonts.fontConfig.fontWeightDescription", {
						defaultValue:
							"Font weight from 100 (thin) to 900 (black), in steps of 100",
					})}
				</p>
				<p className="text-[11px] text-muted-foreground">
					{t("terminalFonts.fontConfig.commonWeights", {
						defaultValue: "Common: 400 (normal), 600 (semi-bold), 700 (bold)",
					})}
				</p>
			</div>

			{/* Line Height */}
			<SliderField
				label={t("terminalFonts.fontConfig.lineHeight", {
					defaultValue: "Line Height",
				})}
				description={t("terminalFonts.fontConfig.lineHeightDescription", {
					defaultValue: "Line height as a multiple of font size (1.0-2.0)",
				})}
				valueLabel={numberFormatter.format(settings.lineHeight)}
				value={settings.lineHeight}
				min={LINE_HEIGHT_MIN}
				max={LINE_HEIGHT_MAX}
				step={LINE_HEIGHT_STEP}
				minLabel={LINE_HEIGHT_MIN.toFixed(1)}
				maxLabel={LINE_HEIGHT_MAX.toFixed(1)}
				ariaValueText={numberFormatter.format(settings.lineHeight)}
				onChange={handleLineHeightChange}
			/>

			{/* Letter Spacing */}
			<SliderField
				label={t("terminalFonts.fontConfig.letterSpacing", {
					defaultValue: "Letter Spacing",
				})}
				description={t("terminalFonts.fontConfig.letterSpacingDescription", {
					defaultValue: "Horizontal spacing between characters (-2 to 5px)",
				})}
				valueLabel={letterSpacingLabel}
				value={settings.letterSpacing}
				min={LETTER_SPACING_MIN}
				max={LETTER_SPACING_MAX}
				step={LETTER_SPACING_STEP}
				minLabel={`${LETTER_SPACING_MIN}px`}
				maxLabel={`+${LETTER_SPACING_MAX}px`}
				ariaValueText={`${letterSpacingLabel.replace("px", "")} ${pixelsLabel}`}
				onChange={handleLetterSpacingChange}
			/>
		</div>
	);
}
