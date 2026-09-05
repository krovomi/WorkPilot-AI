import {
	ClipboardCopy,
	Download,
	Gauge,
	MousePointer2,
	Sparkles,
	Terminal,
	Type,
	Upload,
} from "lucide-react";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../../../hooks/use-toast";
import { MAX_IMPORT_FILE_SIZE } from "../../../lib/terminal-font-constants";
import { cn } from "../../../lib/utils";
import type { TerminalFontSettings } from "../../../stores/terminal-font-settings-store";
import { useTerminalFontSettingsStore } from "../../../stores/terminal-font-settings-store";
import { CursorConfigPanel } from "./CursorConfigPanel";
// Child components
import { FontConfigPanel } from "./FontConfigPanel";
import { LivePreviewTerminal } from "./LivePreviewTerminal";
import { PerformanceConfigPanel } from "./PerformanceConfigPanel";
import { PresetsPanel } from "./PresetsPanel";
import { SettingsCard } from "./SettingsCard";

/**
 * Terminal font settings main container component
 * Orchestrates all terminal font customization panels:
 * - Font configuration (family, size, weight, line height, letter spacing)
 * - Cursor configuration (style, blink, accent color)
 * - Performance settings (scrollback limit)
 * - Quick presets (VS Code, IntelliJ, macOS, Ubuntu)
 * - Live preview terminal (real-time updates, 300ms debounced)
 *
 * All settings persist via localStorage through the Zustand store
 * Changes apply immediately to all active terminal instances
 */
// biome-ignore lint/suspicious/noRedeclare: redeclaration is intentional in this context
export function TerminalFontSettings() {
	const { t } = useTranslation("settings");
	const { toast } = useToast();
	const importInputRef = useRef<HTMLInputElement>(null);

	// Get current settings from store using individual selectors to prevent infinite re-render loop
	// Each selector only re-renders when its specific value changes
	const fontFamily = useTerminalFontSettingsStore((state) => state.fontFamily);
	const fontSize = useTerminalFontSettingsStore((state) => state.fontSize);
	const fontWeight = useTerminalFontSettingsStore((state) => state.fontWeight);
	const lineHeight = useTerminalFontSettingsStore((state) => state.lineHeight);
	const letterSpacing = useTerminalFontSettingsStore(
		(state) => state.letterSpacing,
	);
	const cursorStyle = useTerminalFontSettingsStore(
		(state) => state.cursorStyle,
	);
	const cursorBlink = useTerminalFontSettingsStore(
		(state) => state.cursorBlink,
	);
	const cursorAccentColor = useTerminalFontSettingsStore(
		(state) => state.cursorAccentColor,
	);
	const scrollback = useTerminalFontSettingsStore((state) => state.scrollback);

	// Reconstruct settings object with stable reference using useMemo
	// This prevents the infinite re-render loop caused by creating new object references
	const settings = useMemo<TerminalFontSettings>(
		() => ({
			fontFamily,
			fontSize,
			fontWeight,
			lineHeight,
			letterSpacing,
			cursorStyle,
			cursorBlink,
			cursorAccentColor,
			scrollback,
		}),
		[
			fontFamily,
			fontSize,
			fontWeight,
			lineHeight,
			letterSpacing,
			cursorStyle,
			cursorBlink,
			cursorAccentColor,
			scrollback,
		],
	);

	// Get action methods from store
	const updateSettings = useTerminalFontSettingsStore(
		(state) => state.applySettings,
	);
	const resetToDefaults = useTerminalFontSettingsStore(
		(state) => state.resetToDefaults,
	);
	const applyPreset = useTerminalFontSettingsStore(
		(state) => state.applyPreset,
	);
	const exportSettings = useTerminalFontSettingsStore(
		(state) => state.exportSettings,
	);
	const importSettings = useTerminalFontSettingsStore(
		(state) => state.importSettings,
	);

	/**
	 * Handle individual setting updates
	 * This wrapper ensures type safety and could add validation/logging in future
	 */
	const handleSettingChange = <K extends keyof TerminalFontSettings>(
		key: K,
		value: TerminalFontSettings[K],
	) => {
		updateSettings({ [key]: value });
	};

	/**
	 * Handle preset application
	 */
	const handlePresetApply = (presetName: string) => {
		applyPreset(presetName);
	};

	/**
	 * Handle reset to OS defaults
	 */
	const handleReset = () => {
		resetToDefaults();
	};

	/**
	 * Handle export configuration to JSON file
	 */
	const handleExport = () => {
		try {
			const json = exportSettings();
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = "terminal-font-settings.json";
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(url);

			toast({
				title: t("terminalFonts.importExport.exportSuccess", {
					defaultValue: "Settings exported successfully",
				}),
			});
		} catch (error) {
			console.error("Failed to export settings:", error);
			toast({
				variant: "destructive",
				title: t("terminalFonts.importExport.exportFailed", {
					defaultValue: "Failed to export settings",
				}),
			});
		}
	};

	/**
	 * Handle import configuration from JSON file
	 */
	const handleImport = (file: File) => {
		// Check file size
		if (file.size > MAX_IMPORT_FILE_SIZE) {
			toast({
				variant: "destructive",
				title: t("terminalFonts.importExport.fileTooLarge", {
					defaultValue: "Import file too large (max 10KB)",
				}),
			});
			return;
		}

		const reader = new FileReader();
		reader.onload = (e) => {
			try {
				const json = e.target?.result as string;
				const success = importSettings(json);

				if (success) {
					toast({
						title: t("terminalFonts.importExport.importSuccess", {
							defaultValue: "Settings imported successfully",
						}),
					});
				} else {
					toast({
						variant: "destructive",
						title: t("terminalFonts.importExport.importFailed", {
							defaultValue: "Failed to import settings: Invalid JSON format",
						}),
						description: t("terminalFonts.importExport.importFailedRange", {
							defaultValue: "Values must be within valid ranges",
						}),
					});
				}
			} catch (error) {
				console.error("Failed to import settings:", error);
				toast({
					variant: "destructive",
					title: t("terminalFonts.importExport.readError", {
						defaultValue: "Failed to read file",
					}),
				});
			}
		};

		reader.onerror = () => {
			toast({
				variant: "destructive",
				title: t("terminalFonts.importExport.readError", {
					defaultValue: "Failed to read file",
				}),
			});
		};

		reader.readAsText(file);
	};

	/**
	 * Handle copy configuration to clipboard
	 */
	const handleCopyToClipboard = async () => {
		try {
			const json = exportSettings();
			await navigator.clipboard.writeText(json);

			toast({
				title: t("terminalFonts.importExport.copySuccess", {
					defaultValue: "Settings copied to clipboard",
				}),
			});
		} catch (error) {
			console.error("Failed to copy to clipboard:", error);
			toast({
				variant: "destructive",
				title: t("terminalFonts.importExport.copyFailed", {
					defaultValue: "Failed to copy to clipboard",
				}),
			});
		}
	};

	const toolbarButtonClasses = cn(
		"inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5",
		"text-xs font-medium text-foreground transition-colors hover:bg-accent",
		"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
	);

	return (
		<div className="space-y-6">
			{/* Header: identity on the left, configuration actions on the right.
			    Both halves wrap, so the actions drop under the title on a narrow
			    pane instead of being pushed out of the panel. */}
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex min-w-0 items-start gap-3">
					<span className="shrink-0 rounded-lg bg-primary/10 p-2">
						<Terminal className="h-5 w-5 text-primary" aria-hidden="true" />
					</span>
					<div className="min-w-0">
						<h2 className="text-lg font-semibold text-foreground">
							{t("terminalFonts.title", { defaultValue: "Terminal Fonts" })}
						</h2>
						<p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
							{t("terminalFonts.description", {
								defaultValue:
									"Customize terminal font appearance, cursor behavior, and performance settings. Changes apply immediately to all active terminals.",
							})}
						</p>
					</div>
				</div>

				<fieldset className="flex min-w-0 flex-wrap items-center gap-2 border-0 p-0">
					<legend className="sr-only">
						{t("terminalFonts.configActions", {
							defaultValue: "Configuration:",
						})}
					</legend>
					<button
						type="button"
						onClick={handleExport}
						className={toolbarButtonClasses}
					>
						<Download className="h-3.5 w-3.5" aria-hidden="true" />
						{t("terminalFonts.export", { defaultValue: "Export JSON" })}
					</button>
					<button
						type="button"
						onClick={() => importInputRef.current?.click()}
						className={toolbarButtonClasses}
					>
						<Upload className="h-3.5 w-3.5" aria-hidden="true" />
						{t("terminalFonts.import", { defaultValue: "Import JSON" })}
					</button>
					<input
						ref={importInputRef}
						type="file"
						accept=".json"
						className="hidden"
						tabIndex={-1}
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) {
								handleImport(file);
								e.target.value = ""; // Reset to allow re-importing same file
							}
						}}
					/>
					<button
						type="button"
						onClick={handleCopyToClipboard}
						className={toolbarButtonClasses}
					>
						<ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />
						{t("terminalFonts.copy", { defaultValue: "Copy to Clipboard" })}
					</button>
				</fieldset>
			</div>

			{/* Settings on the left, preview on the right. Both columns carry
			    min-w-0 so the terminal can shrink with its column rather than
			    overflowing onto the controls. */}
			<div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
				<div className="min-w-0 space-y-4">
					<SettingsCard
						icon={Type}
						title={t("terminalFonts.fontConfig.title", {
							defaultValue: "Font Configuration",
						})}
						description={t("terminalFonts.fontConfig.description", {
							defaultValue:
								"Customize font family, size, weight, line height, and letter spacing",
						})}
					>
						<FontConfigPanel
							settings={settings}
							onSettingChange={handleSettingChange}
						/>
					</SettingsCard>

					<SettingsCard
						icon={MousePointer2}
						title={t("terminalFonts.cursorConfig.title", {
							defaultValue: "Cursor Configuration",
						})}
						description={t("terminalFonts.cursorConfig.description", {
							defaultValue:
								"Customize cursor style, blinking behavior, and accent color",
						})}
					>
						<CursorConfigPanel
							settings={settings}
							onSettingChange={handleSettingChange}
						/>
					</SettingsCard>

					<SettingsCard
						icon={Gauge}
						title={t("terminalFonts.performanceConfig.title", {
							defaultValue: "Performance Settings",
						})}
						description={t("terminalFonts.performanceConfig.description", {
							defaultValue:
								"Adjust scrollback limit and other performance-related settings",
						})}
					>
						<PerformanceConfigPanel
							settings={settings}
							onSettingChange={handleSettingChange}
						/>
					</SettingsCard>

					<SettingsCard
						icon={Sparkles}
						title={t("terminalFonts.presets.title", {
							defaultValue: "Quick Presets",
						})}
						description={t("terminalFonts.presets.description", {
							defaultValue:
								"Apply pre-configured presets from popular IDEs and terminals",
						})}
					>
						<PresetsPanel
							onPresetApply={handlePresetApply}
							onReset={handleReset}
							currentSettings={settings}
						/>
					</SettingsCard>
				</div>

				{/* Live Preview Terminal — follows the scroll on wide layouts */}
				<div className="min-w-0">
					<div className="xl:sticky xl:top-4">
						<SettingsCard
							icon={Terminal}
							title={t("terminalFonts.preview.title", {
								defaultValue: "Live Preview",
							})}
							description={t("terminalFonts.preview.description", {
								defaultValue:
									"Preview your terminal settings in real-time (updates within 300ms)",
							})}
						>
							<LivePreviewTerminal settings={settings} />
						</SettingsCard>
					</div>
				</div>
			</div>
		</div>
	);
}
