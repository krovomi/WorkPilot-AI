import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { JevMode, JevSettings as Config } from "../../../shared/types/jev";
import { parseJevSettings } from "../../../shared/utils/jev-settings";
import { saveSettings, useSettingsStore } from "../../stores/settings-store";
import { useJevStore } from "../../stores/jev-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
export function JevSettings() {
	const { t } = useTranslation("settings");
	const saved = useSettingsStore((s) => s.settings.jev);
	const [config, setConfig] = useState<Config>(saved ?? { enabled: false });
	const [key, setKey] = useState("");
	const [workflow, setWorkflow] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const { status, refresh } = useJevStore();
	useEffect(() => {
		void refresh();
	}, [refresh]);
	useEffect(() => {
		setConfig(saved ?? { enabled: false });
	}, [saved]);
	const workflows = [
		...new Set([
			"feature-build",
			"github-review",
			"gitlab-review",
			"azure-devops-review",
			...Object.keys(config.workflows ?? {}),
		]),
	];
	async function action(kind: "save" | "key" | "clear") {
		setBusy(true);
		setMessage("");
		try {
			const result =
				kind === "save"
					? await saveSettings({ jev: parseJevSettings(config) })
					: kind === "key"
						? await window.electronAPI.saveJevKey(key)
						: await window.electronAPI.clearJevKey();
			const ok = typeof result === "boolean" ? result : result.success;
			setMessage(ok ? "saved" : "error");
			if (ok && kind !== "save") setKey("");
			await refresh();
		} catch {
			setMessage("error");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="space-y-5 p-6">
			<h2 className="text-lg font-semibold">{t("jev.title")}</h2>
			<p className="text-sm text-muted-foreground">{t("jev.description")}</p>
			<label className="flex gap-2">
				<input
					type="checkbox"
					checked={config.enabled}
					onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
				/>
				{t("jev.enabled")}
			</label>
			<p role="status">
				{t(
					status === null
						? "jev.unknown"
						: status.configured
							? "jev.configured"
							: "jev.missingKey",
				)}
			</p>
			{status && !status.secureStorageAvailable && (
				<p>{t("jev.storageUnavailable")}</p>
			)}
			<label htmlFor="jev-key" className="block space-y-2">
				{t("jev.apiKey")}
				<Input
					id="jev-key"
					type="password"
					autoComplete="off"
					value={key}
					onChange={(e) => setKey(e.target.value)}
				/>
			</label>
			<div className="flex gap-2">
				<Button
					disabled={busy || !key.trim() || !status?.secureStorageAvailable}
					onClick={() => void action("key")}
				>
					{t("jev.saveKey")}
				</Button>
				<Button
					variant="outline"
					disabled={busy}
					onClick={() => void action("clear")}
				>
					{t("jev.clearKey")}
				</Button>
			</div>
			<h3 className="font-medium">{t("jev.workflows")}</h3>
			{workflows.map((id) => (
				<label key={id} className="flex items-center justify-between gap-3">
					{t("jev.workflowNames." + id, { defaultValue: id })}
					<select
						className="rounded border bg-background p-2"
						value={config.workflows?.[id] ?? "inherit"}
						onChange={(e) =>
							setConfig({
								...config,
								workflows: {
									...config.workflows,
									[id]: e.target.value as JevMode,
								},
							})
						}
					>
						{(["inherit", "enabled", "bypass"] as const).map((mode) => (
							<option key={mode} value={mode}>
								{t("jev.modes." + mode)}
							</option>
						))}
					</select>
				</label>
			))}
			<label htmlFor="jev-workflow" className="block">
				{t("jev.customWorkflow")}
				<Input
					id="jev-workflow"
					value={workflow}
					onChange={(e) => setWorkflow(e.target.value)}
				/>
			</label>
			<Button
				variant="outline"
				disabled={!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(workflow)}
				onClick={() => {
					setConfig({
						...config,
						workflows: { ...config.workflows, [workflow]: "inherit" },
					});
					setWorkflow("");
				}}
			>
				{t("jev.addWorkflow")}
			</Button>
			<div>
				<Button disabled={busy} onClick={() => void action("save")}>
					{t("jev.save")}
				</Button>
			</div>
			{message && <p role="status">{t("jev." + message)}</p>}
		</section>
	);
}
