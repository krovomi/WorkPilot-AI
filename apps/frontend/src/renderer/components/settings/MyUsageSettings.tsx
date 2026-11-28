/**
 * My usage (server mode): what the organization's administrators see of the
 * signed-in person over the last 30 days, who they are, everything the server
 * keeps about them as a file (RGPD articles 15 and 20), and the notice of
 * what is measured, to read again.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MyUsage, UsageNotice } from "@shared/types/server-usage";
import { Button } from "@/components/ui";
import { loadedOf, SheetBody, WAITING } from "../administration/usage/PersonSheet";
import { Shown } from "../administration/usage/UsageSections";
import type { Loaded } from "../administration/usage/use-usage-view";
import { download, periodOf } from "../administration/usage/usage-format";
import { UsageNoticeDialog } from "../auth/UsageNotice";
import { SettingsSection } from "./SettingsSection";

function api() {
	return globalThis.electronAPI?.serverUsage ?? null;
}

export function MyUsageSettings() {
	const { t } = useTranslation("settings");
	const [mine, setMine] = useState<Loaded<MyUsage>>(WAITING);
	const [notice, setNotice] = useState<UsageNotice | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const bridge = api();
		if (!bridge) return;
		let live = true;
		void bridge.getMyUsage(periodOf("30d")).then((result) => {
			if (live) setMine(loadedOf(result));
		});
		return () => {
			live = false;
		};
	}, []);

	async function exportAll() {
		const bridge = api();
		if (!bridge) return;
		const result = await bridge.exportMyUsage();
		if (result.ok) {
			setError(null);
			const day = new Date().toISOString().slice(0, 10);
			download(result.data, `workpilot-my-usage-${day}.json`, "application/json");
		} else setError(result.error);
	}

	async function showNotice() {
		const result = await api()?.getUsageNotice();
		if (result?.ok) setNotice(result.data);
		else if (result) setError(result.error);
	}

	return (
		<SettingsSection title={t("myUsage.title")} description={t("myUsage.description")}>
			<div className="space-y-4">
				<div className="flex flex-wrap gap-2">
					<Button size="sm" variant="outline" onClick={() => void exportAll()}>
						{t("myUsage.export")}
					</Button>
					<Button size="sm" variant="outline" onClick={() => void showNotice()}>
						{t("myUsage.notice")}
					</Button>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{t("myUsage.failed", { error })}
					</p>
				)}
				<Shown loaded={mine}>
					{(data) => (
						<>
							<p className="text-sm text-muted-foreground">
								{t("myUsage.visibleTo", { roles: data.visible_to.join(", ") })}
							</p>
							<SheetBody sheet={data} />
						</>
					)}
				</Shown>
			</div>
			<UsageNoticeDialog notice={notice} onClose={() => setNotice(null)} />
		</SettingsSection>
	);
}
