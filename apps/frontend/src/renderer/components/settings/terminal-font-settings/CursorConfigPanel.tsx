import { MousePointer2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import type { TerminalFontSettings } from "../../../stores/terminal-font-settings-store";
import { Label } from "../../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../ui/select";
import { Switch } from "../../ui/switch";

interface CursorConfigPanelProps {
	settings: TerminalFontSettings;
	onSettingChange: <K extends keyof TerminalFontSettings>(
		key: K,
		value: TerminalFontSettings[K],
	) => void;
}

/**
 * Cursor configuration panel for terminal cursor customization.
 * Provides controls for:
 * - Cursor style (select: block/underline/bar)
 * - Cursor blink (switch: on/off)
 * - Cursor accent color (color picker)
 *
 * All changes apply immediately and persist via the parent store
 */
export function CursorConfigPanel({
	settings,
	onSettingChange,
}: CursorConfigPanelProps) {
	const { t } = useTranslation("settings");

	// Cursor style options (defined inside component to access t())
	const cursorStyles = [
		{
			value: "block" as const,
			label: t("terminalFonts.cursorConfig.styleBlock", {
				defaultValue: "Block",
			}),
			description: t("terminalFonts.cursorConfig.styleBlockDescription", {
				defaultValue: "Full block cursor",
			}),
		},
		{
			value: "underline" as const,
			label: t("terminalFonts.cursorConfig.styleUnderline", {
				defaultValue: "Underline",
			}),
			description: t("terminalFonts.cursorConfig.styleUnderlineDescription", {
				defaultValue: "Underline cursor",
			}),
		},
		{
			value: "bar" as const,
			label: t("terminalFonts.cursorConfig.styleBar", { defaultValue: "Bar" }),
			description: t("terminalFonts.cursorConfig.styleBarDescription", {
				defaultValue: "Vertical bar cursor",
			}),
		},
	];

	// Handle cursor style change
	const handleCursorStyleChange = (value: "block" | "underline" | "bar") => {
		onSettingChange("cursorStyle", value);
	};

	// Handle cursor blink change
	const handleCursorBlinkChange = (checked: boolean) => {
		onSettingChange("cursorBlink", checked);
	};

	// Handle cursor accent color change
	const handleCursorAccentColorChange = (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const color = event.target.value;
		onSettingChange("cursorAccentColor", color);
	};

	return (
		<div className="space-y-6">
			{/* Cursor Style */}
			<div className="space-y-2.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Label className="flex items-center gap-2 text-sm font-medium text-foreground">
						<MousePointer2 className="h-4 w-4 text-muted-foreground" />
						{t("terminalFonts.cursorConfig.cursorStyle", {
							defaultValue: "Cursor Style",
						})}
					</Label>
					<span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 text-xs font-medium text-foreground">
						{cursorStyles.find((s) => s.value === settings.cursorStyle)
							?.label || settings.cursorStyle}
					</span>
				</div>
				<p className="text-xs leading-relaxed text-muted-foreground">
					{t("terminalFonts.cursorConfig.cursorStyleDescription", {
						defaultValue: "Choose the appearance of the terminal cursor",
					})}
				</p>
				<Select
					value={settings.cursorStyle}
					onValueChange={handleCursorStyleChange}
				>
					<SelectTrigger id="cursor-style">
						<SelectValue
							placeholder={t("terminalFonts.cursorConfig.selectStyle", {
								defaultValue: "Select cursor style...",
							})}
						/>
					</SelectTrigger>
					<SelectContent>
						{cursorStyles.map((style) => (
							<SelectItem key={style.value} value={style.value}>
								<div className="flex flex-col">
									<span className="font-medium">{style.label}</span>
									<span className="text-xs text-muted-foreground">
										{style.description}
									</span>
								</div>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Cursor Blink */}
			<div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-background/40 p-3">
				<div className="min-w-0 space-y-1">
					<Label className="text-sm font-medium text-foreground">
						{t("terminalFonts.cursorConfig.cursorBlink", {
							defaultValue: "Cursor Blink",
						})}
					</Label>
					<p className="text-xs leading-relaxed text-muted-foreground">
						{t("terminalFonts.cursorConfig.cursorBlinkDescription", {
							defaultValue: "Enable or disable cursor blinking animation",
						})}
					</p>
					<p className="text-[11px] text-muted-foreground">
						{t("terminalFonts.cursorConfig.blinkStatus", {
							defaultValue: "Status:",
						})}{" "}
						<span
							className={cn(
								"font-medium",
								settings.cursorBlink
									? "text-green-600 dark:text-green-400"
									: "text-muted-foreground",
							)}
						>
							{settings.cursorBlink
								? t("terminalFonts.cursorConfig.enabled", {
										defaultValue: "Enabled",
									})
								: t("terminalFonts.cursorConfig.disabled", {
										defaultValue: "Disabled",
									})}
						</span>
					</p>
				</div>
				<Switch
					id="cursor-blink"
					checked={settings.cursorBlink}
					onCheckedChange={handleCursorBlinkChange}
					className="mt-0.5 shrink-0"
				/>
			</div>

			{/* Cursor Accent Color */}
			<div className="space-y-2.5">
				<Label className="text-sm font-medium text-foreground">
					{t("terminalFonts.cursorConfig.cursorAccentColor", {
						defaultValue: "Cursor Accent Color",
					})}
				</Label>
				<p
					id="cursor-color-description"
					className="text-xs leading-relaxed text-muted-foreground"
				>
					{t("terminalFonts.cursorConfig.cursorAccentColorDescription", {
						defaultValue:
							"Color of the cursor when visible (affects contrast and visibility)",
					})}
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<input
						type="color"
						id="cursor-accent-color"
						value={settings.cursorAccentColor}
						onChange={handleCursorAccentColorChange}
						aria-label={t("terminalFonts.cursorConfig.cursorAccentColor", {
							defaultValue: "Cursor Accent Color",
						})}
						aria-describedby="cursor-color-description"
						className={cn(
							"h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-0",
							"focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary",
							"transition-colors duration-200",
						)}
						title={t("terminalFonts.cursorConfig.pickColor", {
							defaultValue: "Click to pick a color",
						})}
					/>
					<code className="rounded-md border border-border bg-muted/60 px-2.5 py-1.5 font-mono text-xs text-foreground">
						{settings.cursorAccentColor.toUpperCase()}
					</code>

					{/* Live sample of the cursor over a terminal-like background */}
					<div className="relative h-9 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
						{settings.cursorStyle === "block" && (
							<div
								className="absolute left-2 top-2 h-5 w-2.5"
								style={{ backgroundColor: settings.cursorAccentColor }}
							/>
						)}
						{settings.cursorStyle === "underline" && (
							<div
								className="absolute bottom-2 left-2 h-1 w-2.5"
								style={{ backgroundColor: settings.cursorAccentColor }}
							/>
						)}
						{settings.cursorStyle === "bar" && (
							<div
								className="absolute left-2 top-2 h-5 w-0.5"
								style={{ backgroundColor: settings.cursorAccentColor }}
							/>
						)}
					</div>

					<button
						type="button"
						onClick={() => onSettingChange("cursorAccentColor", "#000000")}
						className={cn(
							"ml-auto rounded-md px-2.5 py-1.5 text-xs font-medium",
							"border border-border bg-card hover:bg-accent",
							"text-foreground transition-colors duration-200",
							"focus:outline-none focus:ring-2 focus:ring-ring",
						)}
						title={t("terminalFonts.cursorConfig.resetColor", {
							defaultValue: "Reset to black",
						})}
					>
						{t("terminalFonts.cursorConfig.reset", {
							defaultValue: "Reset",
						})}
					</button>
				</div>
			</div>
		</div>
	);
}
