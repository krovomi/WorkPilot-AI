import { FolderOpen, Info, Lock, Plus, RotateCcw, Shield, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SandboxMode } from "../../../shared/types";
import { MAX_ALLOWED_PATHS, normalizeAllowedPath } from "../../../shared/utils/agent-safety";
import { cn } from "@/lib/utils";
import { Input } from "../ui/input";
import {
	type AgentSafetyPageProps,
	RangeRow,
	SwitchRow,
	useAgentSafety,
} from "./agent-safety-controls";
import { MicrovmSettings } from "./MicrovmSettings";
import { SettingsSection } from "./SettingsSection";

const K = "sections.sandbox";

/**
 * Settings, Sandbox: the snapshot taken before each agent session and the
 * limits a session works within. Saved with the other settings and sent to
 * every agent process (`main/agent/agent-safety-env.ts`); applied by
 * `apps/backend/security/sandbox.py` and `agents/safety_watch.py`.
 */
export function SandboxSettings(props: AgentSafetyPageProps) {
	const { t } = useTranslation("settings");
	const { safety, update } = useAgentSafety(props);
	const { snapshots, sandbox } = safety;
	const [newPath, setNewPath] = useState("");
	const candidate = normalizeAllowedPath(newPath);
	const canAdd =
		candidate !== null &&
		!sandbox.allowedPaths.includes(candidate) &&
		sandbox.allowedPaths.length < MAX_ALLOWED_PATHS;

	const addPath = () => {
		if (!canAdd || candidate === null) return;
		update("sandbox", { allowedPaths: [...sandbox.allowedPaths, candidate] });
		setNewPath("");
	};
	const noLimit = (value: number, unit = "") =>
		value === 0 ? t(`${K}.limits.none`) : `${value}${unit}`;

	const modes: { id: SandboxMode; label: string; desc: string }[] = [
		{ id: "normal", label: t(`${K}.mode.normal.label`), desc: t(`${K}.mode.normal.description`) },
		{
			id: "restricted",
			label: t(`${K}.mode.restricted.label`),
			desc: t(`${K}.mode.restricted.description`),
		},
	];

	return (
		<SettingsSection title={t(`${K}.title`)} description={t(`${K}.description`)}>
			<div className="space-y-8">
				<div className="space-y-3">
					<h4 className="text-sm font-semibold flex items-center gap-2">
						<RotateCcw className="h-4 w-4 text-primary" />
						{t(`${K}.snapshots.title`)}
					</h4>
					<p className="text-xs text-muted-foreground">{t(`${K}.snapshots.description`)}</p>
					<SwitchRow
						id="sandbox-snapshots"
						icon={<RotateCcw className="h-5 w-5 text-primary" />}
						title={t(`${K}.snapshots.enable`)}
						description={t(`${K}.snapshots.enableHint`)}
						checked={snapshots.enabled}
						onChange={(enabled) => update("snapshots", { enabled })}
					/>
					<SwitchRow
						id="sandbox-auto-rollback"
						icon={<Shield className="h-5 w-5 text-primary" />}
						title={t(`${K}.snapshots.autoRollback`)}
						description={t(`${K}.snapshots.autoRollbackHint`)}
						checked={snapshots.autoRollback}
						onChange={(autoRollback) => update("snapshots", { autoRollback })}
					/>
					<RangeRow
						id="sandbox-snapshots-keep"
						label={t(`${K}.snapshots.keep`)}
						hint={t(`${K}.snapshots.keepHint`)}
						value={snapshots.keep}
						min={1}
						max={50}
						step={1}
						onChange={(keep) => update("snapshots", { keep })}
					/>
				</div>

				<MicrovmSettings
					microvm={sandbox.microvm}
					onChange={(patch) => update("sandbox", { microvm: { ...sandbox.microvm, ...patch } })}
				/>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<Shield className="h-4 w-4 text-primary" />
						{t(`${K}.mode.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">{t(`${K}.mode.description`)}</p>
					<div className="grid grid-cols-2 gap-3">
						{modes.map((m) => (
							<button
								type="button"
								key={m.id}
								onClick={() => update("sandbox", { mode: m.id })}
								aria-pressed={sandbox.mode === m.id}
								className={cn(
									"flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
									sandbox.mode === m.id
										? "border-primary bg-primary/5 ring-1 ring-primary"
										: "border-border hover:bg-accent/50",
								)}
							>
								<span className="text-sm font-medium">{m.label}</span>
								<span className="text-xs text-muted-foreground">{m.desc}</span>
							</button>
						))}
					</div>
				</div>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<FolderOpen className="h-4 w-4 text-primary" />
						{t(`${K}.paths.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">{t(`${K}.paths.description`)}</p>
					<div className="space-y-2">
						{sandbox.allowedPaths.map((entry) => (
							<div
								key={entry}
								className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
							>
								<FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
								<code className="flex-1 font-mono text-xs">{entry}</code>
								<button
									type="button"
									onClick={() =>
										update("sandbox", {
											allowedPaths: sandbox.allowedPaths.filter((p) => p !== entry),
										})
									}
									aria-label={t(`${K}.paths.remove`, { path: entry })}
									className="text-muted-foreground hover:text-destructive"
								>
									<Trash2 className="h-3.5 w-3.5" />
								</button>
							</div>
						))}
						{sandbox.mode === "restricted" && sandbox.allowedPaths.length === 0 && (
							<p className="text-xs text-warning">{t(`${K}.paths.emptyRestricted`)}</p>
						)}
						<div className="flex items-center gap-2">
							<Input
								value={newPath}
								onChange={(e) => setNewPath(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && addPath()}
								placeholder={t(`${K}.paths.placeholder`)}
								aria-label={t(`${K}.paths.placeholder`)}
								className="flex-1 px-3 py-1.5 text-sm h-auto"
							/>
							<button
								type="button"
								onClick={addPath}
								disabled={!canAdd}
								className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
							>
								<Plus className="h-3.5 w-3.5" />
								{t(`${K}.paths.add`)}
							</button>
						</div>
						{newPath.trim() !== "" && candidate === null && (
							<p className="text-xs text-destructive">{t(`${K}.paths.invalid`)}</p>
						)}
					</div>
				</div>

				<div>
					<h4 className="text-sm font-semibold mb-1 flex items-center gap-2">
						<Lock className="h-4 w-4 text-primary" />
						{t(`${K}.limits.title`)}
					</h4>
					<p className="text-xs text-muted-foreground mb-3">{t(`${K}.limits.description`)}</p>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<RangeRow
							id="sandbox-max-files"
							label={t(`${K}.limits.maxFiles`)}
							hint={t(`${K}.limits.maxFilesHint`)}
							value={sandbox.maxFilesWritten}
							display={noLimit(sandbox.maxFilesWritten)}
							min={0}
							max={1000}
							step={10}
							onChange={(maxFilesWritten) => update("sandbox", { maxFilesWritten })}
						/>
						<RangeRow
							id="sandbox-max-file-size"
							label={t(`${K}.limits.maxFileSize`)}
							hint={t(`${K}.limits.maxFileSizeHint`)}
							value={sandbox.maxFileSizeMb}
							display={noLimit(sandbox.maxFileSizeMb, " MB")}
							min={0}
							max={100}
							step={1}
							onChange={(maxFileSizeMb) => update("sandbox", { maxFileSizeMb })}
						/>
						<RangeRow
							id="sandbox-max-session"
							label={t(`${K}.limits.maxSession`)}
							hint={t(`${K}.limits.maxSessionHint`)}
							value={sandbox.maxSessionMinutes}
							display={noLimit(sandbox.maxSessionMinutes, " min")}
							min={0}
							max={240}
							step={10}
							onChange={(maxSessionMinutes) => update("sandbox", { maxSessionMinutes })}
						/>
					</div>
				</div>

				<div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
					<div className="flex items-start gap-2">
						<Info className="h-4 w-4 text-primary mt-0.5 shrink-0" />
						<span>{t(`${K}.always`)}</span>
					</div>
				</div>
			</div>
		</SettingsSection>
	);
}
