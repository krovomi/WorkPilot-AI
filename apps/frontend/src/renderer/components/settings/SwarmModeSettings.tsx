import { AlertTriangle, Cpu, Info, RotateCcw, Zap } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
	DEFAULT_SWARM_SETTINGS,
	type SwarmSettings,
} from "../../../shared/types/swarm";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { Notice } from "../charter";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { SettingsSection } from "./SettingsSection";

/**
 * Swarm Mode settings panel.
 *
 * The setting is saved with the app's settings and sent to every task's
 * build: when it is on, the build runs the subtasks its plan lets run side
 * by side in parallel, each in its own worktree, and merges them wave after
 * wave. Works with any LLM configured in the user's active profile.
 */
export function SwarmModeSettings() {
	const { t } = useTranslation(["swarm", "common"]);
	const saved = useSettingsStore((s) => s.settings.swarm);
	const config = { ...DEFAULT_SWARM_SETTINGS, ...saved };
	const isEnabled = config.enabled;
	const [saveFailed, setSaveFailed] = useState(false);
	const setConfig = (partial: Partial<SwarmSettings>) => {
		void saveSettings({ swarm: { ...config, ...partial } }).then((ok) =>
			setSaveFailed(!ok),
		);
	};
	const setEnabled = (enabled: boolean) => setConfig({ enabled });

	return (
		<SettingsSection title={t("swarm:title")} description={t("swarm:subtitle")}>
			<div className="space-y-6">
				{/* ── Master Toggle ──────────────────────────────── */}
				<div className="flex items-center justify-between rounded-lg border border-border p-4">
					<div className="flex items-center gap-3">
						<div
							className={cn(
								"flex h-10 w-10 items-center justify-center rounded-lg",
								isEnabled
									? "bg-primary/10 text-primary"
									: "bg-muted text-muted-foreground",
							)}
						>
							<Zap className="h-5 w-5" />
						</div>
						<div>
							<Label className="text-sm font-medium">{t("swarm:enable")}</Label>
							<p className="text-xs text-muted-foreground mt-0.5">
								{t("swarm:subtitle")}
							</p>
						</div>
					</div>
					<Switch checked={isEnabled} onCheckedChange={setEnabled} />
				</div>

				{saveFailed && (
					<Notice tone="red" icon={AlertTriangle}>
						{t("swarm:saveFailed")}
					</Notice>
				)}

				{/* ── Info Banner ────────────────────────────────── */}
				{isEnabled && (
					<Notice tone="blue" icon={Info}>
						{t("swarm:infoBanner")}
					</Notice>
				)}

				{/* ── Sub-options ────────────────────────────────── */}
				{isEnabled && (
					<div className="pl-4 space-y-5 border-l-2 border-primary/20">
						{/* Max Parallel Agents */}
						<div className="space-y-2.5">
							<div className="flex items-center justify-between">
								<Label className="text-sm font-medium flex items-center gap-2">
									<Cpu className="h-3.5 w-3.5 text-primary" />
									{t("swarm:config.maxParallel")}
								</Label>
								<span className="text-sm font-mono tabular-nums bg-muted px-2 py-0.5 rounded">
									{config.maxParallelAgents}
								</span>
							</div>
							<input
								type="range"
								min={2}
								max={8}
								step={1}
								value={config.maxParallelAgents}
								onChange={(e) =>
									setConfig({
										maxParallelAgents: Number.parseInt(e.target.value, 10),
									})
								}
								className="w-full accent-primary"
							/>
							<div className="flex justify-between text-3xs text-muted-foreground px-0.5">
								<span>2</span>
								<span>4</span>
								<span>6</span>
								<span>8</span>
							</div>
							<p className="text-xs text-muted-foreground">
								{t("swarm:config.maxParallelDesc")}
							</p>
						</div>

						{/* Fail Fast */}
						<div className="flex items-center justify-between">
							<div>
								<Label className="text-sm font-medium flex items-center gap-2">
									<AlertTriangle className="h-3.5 w-3.5 text-primary" />
									{t("swarm:config.failFast")}
								</Label>
								<p className="text-xs text-muted-foreground mt-0.5">
									{t("swarm:config.failFastDesc")}
								</p>
							</div>
							<Switch
								checked={config.failFast}
								onCheckedChange={(v) => setConfig({ failFast: v })}
							/>
						</div>

						{/* Max Retries */}
						<div className="space-y-2.5">
							<div className="flex items-center justify-between">
								<Label className="text-sm font-medium flex items-center gap-2">
									<RotateCcw className="h-3.5 w-3.5 text-primary" />
									{t("swarm:config.maxRetries")}
								</Label>
								<span className="text-sm font-mono tabular-nums bg-muted px-2 py-0.5 rounded">
									{config.maxRetriesPerSubtask}
								</span>
							</div>
							<input
								type="range"
								min={0}
								max={5}
								step={1}
								value={config.maxRetriesPerSubtask}
								onChange={(e) =>
									setConfig({
										maxRetriesPerSubtask: Number.parseInt(e.target.value, 10),
									})
								}
								className="w-full accent-primary"
							/>
							<div className="flex justify-between text-3xs text-muted-foreground px-0.5">
								<span>0</span>
								<span>1</span>
								<span>2</span>
								<span>3</span>
								<span>4</span>
								<span>5</span>
							</div>
						</div>

					</div>
				)}
			</div>
		</SettingsSection>
	);
}
