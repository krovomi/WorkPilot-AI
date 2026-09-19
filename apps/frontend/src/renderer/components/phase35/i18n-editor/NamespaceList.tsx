/**
 * The editor's left pane: every namespace, and how far from done it is.
 *
 * The completeness bar is the reason this pane exists. A list of 101 names
 * tells a translator nothing about where the work is; the same list ordered by
 * what is missing answers it at a glance, which is why "least complete first"
 * is the default sort and the untranslated count is the only number shown.
 */

import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { I18nNamespaceSummary } from "../../../../preload/api/modules/phase35-features-api";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";

interface NamespaceListProps {
	namespaces: I18nNamespaceSummary[];
	locales: string[];
	selected: string | null;
	onSelect: (namespace: string) => void;
	/** Blocks navigation while a save is in flight so a draft cannot be stranded. */
	disabled?: boolean;
}

type Sort = "todo" | "name";

/** Keys with no value in some locale, summed over the locales. */
function untranslatedCount(summary: I18nNamespaceSummary): number {
	return Object.values(summary.missing).reduce((a, b) => a + b, 0);
}

function completeness(summary: I18nNamespaceSummary, locales: string[]): number {
	const total = summary.total_keys * Math.max(locales.length, 1);
	if (total === 0) return 1;
	const done = locales.reduce((n, l) => n + (summary.translated[l] ?? 0), 0);
	return done / total;
}

export function NamespaceList({
	namespaces,
	locales,
	selected,
	onSelect,
	disabled,
}: NamespaceListProps) {
	const { t } = useTranslation("phase35");
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<Sort>("todo");

	const rows = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = q
			? namespaces.filter((n) => n.namespace.toLowerCase().includes(q))
			: namespaces;
		const sorted = [...filtered];
		if (sort === "name") {
			sorted.sort((a, b) => a.namespace.localeCompare(b.namespace));
		} else {
			sorted.sort(
				(a, b) =>
					untranslatedCount(b) - untranslatedCount(a) ||
					completeness(a, locales) - completeness(b, locales) ||
					a.namespace.localeCompare(b.namespace),
			);
		}
		return sorted;
	}, [namespaces, query, sort, locales]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="space-y-2 p-2">
				<div className="relative">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("i18nEditor.searchNamespaces")}
						aria-label={t("i18nEditor.searchNamespaces")}
						className="w-full rounded border bg-background py-1.5 pl-7 pr-2 text-xs"
					/>
				</div>
				<div className="flex gap-1">
					{(["todo", "name"] as const).map((value) => (
						<Button
							key={value}
							size="sm"
							variant={sort === value ? "secondary" : "ghost"}
							className="h-6 flex-1 px-2 text-[11px]"
							onClick={() => setSort(value)}
						>
							{t(`i18nEditor.sort.${value}`)}
						</Button>
					))}
				</div>
			</div>

			<ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
				{rows.map((summary) => {
					const todo = untranslatedCount(summary);
					const ratio = completeness(summary, locales);
					const isSelected = summary.namespace === selected;
					return (
						<li key={summary.namespace || "__flat__"}>
							<button
								type="button"
								disabled={disabled}
								onClick={() => onSelect(summary.namespace)}
								aria-current={isSelected || undefined}
								className={cn(
									"w-full rounded-md px-2 py-1.5 text-left transition-colors",
									"hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
									isSelected && "bg-accent",
								)}
							>
								<div className="flex items-baseline gap-2">
									<span className="min-w-0 flex-1 truncate font-mono text-xs">
										{summary.namespace || t("i18nEditor.flatNamespace")}
									</span>
									{todo === 0 ? (
										<Check
											className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
											aria-label={t("i18nEditor.complete")}
										/>
									) : (
										<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
											{todo}
										</span>
									)}
								</div>
								{/*
								 * Shape carries the state and colour only doubles it: the bar
								 * is a length, readable in all seven themes and without
								 * colour vision. The activity-store rules make the same call.
								 */}
								<div
									className="mt-1 h-1 overflow-hidden rounded-full bg-muted"
									role="img"
									aria-label={t("i18nEditor.completeness", {
										percent: Math.round(ratio * 100),
									})}
								>
									<div
										className={cn(
											"h-full rounded-full transition-all",
											ratio === 1 ? "bg-muted-foreground/40" : "bg-primary",
										)}
										style={{ width: `${Math.round(ratio * 100)}%` }}
									/>
								</div>
							</button>
						</li>
					);
				})}
				{rows.length === 0 && (
					<li className="px-2 py-6 text-center text-xs text-muted-foreground">
						{t("i18nEditor.noNamespaceMatches")}
					</li>
				)}
			</ul>
		</div>
	);
}
