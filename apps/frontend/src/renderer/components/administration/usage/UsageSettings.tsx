/**
 * Usage: what the server collects about the organization's members, and for
 * how long (`usage.read` to read, `usage.write` to change).
 *
 * Page activity is off until an administrator turns it on, once the members
 * have been told what is measured; turning it off erases the counts kept so
 * far. A retention left empty keeps the server's. The server checks the
 * permission and the bounds again; this tab only offers what it would accept.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UsageSettings } from "@shared/types/server-usage";
import { Button, Input, Label } from "@/components/ui";
import { formatAppDateTime } from "@/lib/date-format";
import { usePermission } from "@/stores/permissions-store";

const MIN_DAYS = 30;
const MAX_DAYS = 3650;

type Status = "loading" | "ready" | "saving" | "saved";

function api() {
	return globalThis.electronAPI?.serverUsage ?? null;
}

/** An empty field (the server's retention), a valid number of days, or undefined. */
function daysOf(raw: string): number | null | undefined {
	const value = raw.trim();
	if (value === "") return null;
	const days = Number(value);
	return Number.isInteger(days) && days >= MIN_DAYS && days <= MAX_DAYS ? days : undefined;
}

export function UsageSettings() {
	const { t } = useTranslation("administration");
	const canWrite = usePermission("usage.write");
	const [settings, setSettings] = useState<UsageSettings | null>(null);
	const [pageActivity, setPageActivity] = useState(false);
	const [usageDays, setUsageDays] = useState("");
	const [pageDays, setPageDays] = useState("");
	const [status, setStatus] = useState<Status>("loading");
	const [error, setError] = useState<string | null>(null);

	const show = useCallback((next: UsageSettings) => {
		setSettings(next);
		setPageActivity(next.page_activity);
		setUsageDays(next.usage_retention_days?.toString() ?? "");
		setPageDays(next.page_activity_retention_days?.toString() ?? "");
	}, []);

	useEffect(() => {
		let live = true;
		void api()
			?.getUsageSettings()
			.then((result) => {
				if (!live) return;
				if (result.ok) show(result.data);
				else setError(result.error);
				setStatus("ready");
			});
		return () => {
			live = false;
		};
	}, [show]);

	const usage = daysOf(usageDays);
	const pages = daysOf(pageDays);
	const valid = usage !== undefined && pages !== undefined;
	const erasing = settings?.page_activity === true && !pageActivity;

	async function save() {
		const bridge = api();
		if (!bridge || usage === undefined || pages === undefined) return;
		setStatus("saving");
		setError(null);
		const result = await bridge.setUsageSettings({
			page_activity: pageActivity,
			usage_retention_days: usage,
			page_activity_retention_days: pages,
		});
		if (result.ok) {
			show(result.data);
			setStatus("saved");
		} else {
			setError(result.error);
			setStatus("ready");
		}
	}

	if (status === "loading") {
		return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
	}

	return (
		<div className="max-w-2xl space-y-6">
			<p className="text-sm text-muted-foreground">{t("usage.description")}</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{t("usage.failed", { error })}
				</p>
			)}

			<section className="space-y-2">
				<h3 className="text-sm font-semibold">{t("usage.pageActivity.title")}</h3>
				<p className="text-sm text-muted-foreground">{t("usage.pageActivity.what")}</p>
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={pageActivity}
						disabled={!canWrite}
						onChange={(e) => setPageActivity(e.target.checked)}
					/>
					{t("usage.pageActivity.toggle")}
				</label>
				<p className="text-xs text-muted-foreground">
					{settings?.page_activity && settings.page_activity_since
						? t("usage.pageActivity.since", {
								date: formatAppDateTime(settings.page_activity_since),
							})
						: t("usage.pageActivity.inform")}
				</p>
				{erasing && (
					<p role="status" className="text-xs text-warning">
						{t("usage.pageActivity.erase")}
					</p>
				)}
			</section>

			<section className="space-y-4">
				<h3 className="text-sm font-semibold">{t("usage.retention.title")}</h3>
				<div className="space-y-1">
					<Label htmlFor="usage-retention">{t("usage.retention.usage")}</Label>
					<Input
						id="usage-retention"
						type="number"
						min={MIN_DAYS}
						max={MAX_DAYS}
						inputMode="numeric"
						disabled={!canWrite}
						placeholder={t("usage.retention.serverDefault", {
							count: settings?.defaults.usage_retention_days ?? 365,
						})}
						value={usageDays}
						onChange={(e) => setUsageDays(e.target.value)}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="page-retention">{t("usage.retention.pages")}</Label>
					<Input
						id="page-retention"
						type="number"
						min={MIN_DAYS}
						max={MAX_DAYS}
						inputMode="numeric"
						disabled={!canWrite}
						placeholder={t("usage.retention.serverDefault", {
							count: settings?.defaults.page_activity_retention_days ?? 183,
						})}
						value={pageDays}
						onChange={(e) => setPageDays(e.target.value)}
					/>
				</div>
				<p className="text-xs text-muted-foreground">
					{valid
						? t("usage.retention.hint", { min: MIN_DAYS, max: MAX_DAYS })
						: t("usage.retention.invalid", { min: MIN_DAYS, max: MAX_DAYS })}
				</p>
			</section>

			{canWrite && (
				<div className="flex items-center gap-3">
					<Button onClick={() => void save()} disabled={!valid || status === "saving"}>
						{t("common.save")}
					</Button>
					{status === "saved" && (
						<span role="status" className="text-xs text-muted-foreground">
							{t("usage.saved")}
						</span>
					)}
				</div>
			)}
		</div>
	);
}
