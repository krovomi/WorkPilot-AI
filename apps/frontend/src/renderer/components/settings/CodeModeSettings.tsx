import { Braces, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "../../../shared/types";
import { CODE_MODES, normalizeCodeMode } from "../../../shared/utils/code-mode";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./SettingsSection";

const K = "sections.codeMode";

interface CodeModeSettingsProps {
	readonly settings: AppSettings;
	readonly onSettingsChange: (settings: AppSettings) => void;
}

/**
 * Settings, Code mode: the switch for `run_script`, the tool that lets an
 * agent chain its other tools in a short script. Saved with the other
 * settings and sent to every agent process (`main/agent/code-mode-env.ts`);
 * applied by `apps/backend/code_mode/settings.py`. Off is the product as it
 * was before code mode.
 */
export function CodeModeSettings({ settings, onSettingsChange }: CodeModeSettingsProps) {
	const { t } = useTranslation("settings");
	const current = normalizeCodeMode(settings.codeMode);

	return (
		<SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
			<div className="space-y-6">
				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<Braces className="h-4 w-4 text-primary" />
						{t(`${K}.mode.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">{t(`${K}.mode.description`)}</p>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						{CODE_MODES.map((mode) => (
							<button
								type="button"
								key={mode}
								data-testid={`code-mode-${mode}`}
								onClick={() => onSettingsChange({ ...settings, codeMode: mode })}
								aria-pressed={current === mode}
								className={cn(
									"flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
									current === mode
										? "border-primary bg-primary/5 ring-1 ring-primary"
										: "border-border hover:bg-accent/50",
								)}
							>
								<span className="text-sm font-medium">{t(`${K}.mode.${mode}.label`)}</span>
								<span className="text-xs text-muted-foreground">
									{t(`${K}.mode.${mode}.description`)}
								</span>
							</button>
						))}
					</div>
				</div>
				<div className="flex items-start gap-3 rounded-lg border border-border p-3">
					<ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
					<div className="space-y-1">
						<p className="text-sm font-medium">{t(`${K}.safety.title`)}</p>
						<p className="text-xs text-muted-foreground">{t(`${K}.safety.description`)}</p>
					</div>
				</div>
				<p className="text-xs text-muted-foreground">{t(`${K}.providers`)}</p>
			</div>
		</SettingsSection>
	);
}
