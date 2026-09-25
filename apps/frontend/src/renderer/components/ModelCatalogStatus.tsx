/**
 * ModelCatalogStatus — small inline indicator showing where the current model
 * list comes from (provider API, public registry, cache, static fallback) plus
 * a refresh button that bypasses the backend cache.
 */

import { Loader2, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ProviderModelCatalog } from "../hooks/useProviderModelCatalog";
import { cn } from "../lib/utils";

interface ModelCatalogStatusProps {
	catalog: ProviderModelCatalog;
	className?: string;
}

type TFunction = ReturnType<typeof useTranslation>["t"];

function formatRelative(ts: number | null, t: TFunction): string {
	if (!ts) return t("common:modelCatalog.justNow");
	const minutes = Math.floor((Date.now() - ts * 1000) / 60000);
	if (minutes < 1) return t("common:modelCatalog.justNow");
	if (minutes < 60) return t("common:modelCatalog.minutesAgo", { count: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("common:modelCatalog.hoursAgo", { count: hours });
	return t("common:modelCatalog.daysAgo", { count: Math.floor(hours / 24) });
}

export function ModelCatalogStatus({
	catalog,
	className,
}: ModelCatalogStatusProps) {
	const { t } = useTranslation(["common"]);
	const { source, fetchedAt, error, loading, refresh } = catalog;

	const Icon = error || source === "static" ? WifiOff : Wifi;
	const label =
		source === "cache"
			? t("common:modelCatalog.cache", { when: formatRelative(fetchedAt, t) })
			: t(`common:modelCatalog.${source}`);

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 text-[10px] text-muted-foreground",
				className,
			)}
			title={
				source === "registry" ? t("common:modelCatalog.registryHint") : undefined
			}
		>
			<Icon className="h-3 w-3" />
			<span>{label}</span>
			<button
				type="button"
				onClick={refresh}
				disabled={loading}
				aria-label={t("common:modelCatalog.refresh")}
				className={cn(
					"ml-1 rounded p-0.5 hover:bg-muted disabled:opacity-50",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				)}
			>
				{loading ? (
					<Loader2 className="h-3 w-3 animate-spin" />
				) : (
					<RefreshCw className="h-3 w-3" />
				)}
			</button>
		</div>
	);
}
