import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Chip, Chips, EmptyStage } from "../charter";
import { Input } from "../ui/input";
import {
	CleanProviderCard,
	type ProviderCardData,
	type ProviderCardStatus,
	providerCardStatus,
} from "./CleanProviderCard";

type Filter = "all" | "connected" | "available" | "attention";

const MATCHES: Record<Filter, (status: ProviderCardStatus) => boolean> = {
	all: () => true,
	connected: (status) => status !== "off",
	available: (status) => status === "off",
	attention: (status) => status === "reauth" || status === "failing",
};

interface CleanProviderGridProps {
	readonly providers: ProviderCardData[];
	readonly defaultProvider?: string;
	readonly testingProviders?: ReadonlySet<string>;
	readonly onConfigure: (providerId: string, options?: { startOAuth?: boolean }) => void;
	readonly onTest?: (providerId: string) => void;
	readonly onSetDefault?: (providerId: string) => void;
	readonly onManageAccounts?: (providerId: string) => void;
}

/**
 * The providers of Settings → AI accounts: a search, filter chips with their
 * counts, then the connected providers above the ones left to connect.
 */
export function CleanProviderGrid({
	providers,
	defaultProvider,
	testingProviders,
	onConfigure,
	onTest,
	onSetDefault,
	onManageAccounts,
}: CleanProviderGridProps) {
	const { t } = useTranslation("settings");
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");

	const withStatus = useMemo(
		() => providers.map((provider) => ({ provider, status: providerCardStatus(provider) })),
		[providers],
	);
	const counts = useMemo(() => {
		const count = (f: Filter) => withStatus.filter(({ status }) => MATCHES[f](status)).length;
		return { all: withStatus.length, connected: count("connected"), available: count("available"), attention: count("attention") };
	}, [withStatus]);

	const needle = query.trim().toLowerCase();
	const shown = withStatus.filter(
		({ provider, status }) =>
			MATCHES[filter](status) &&
			(!needle ||
				provider.name.toLowerCase().includes(needle) ||
				provider.description?.toLowerCase().includes(needle)),
	);
	const groups = [
		{ id: "connected", items: shown.filter(({ status }) => status !== "off") },
		{ id: "available", items: shown.filter(({ status }) => status === "off") },
	].filter((group) => group.items.length > 0);

	const filters: Filter[] = ["all", "connected", "available", "attention"];

	return (
		<div className="flex flex-col gap-5">
			<div className="flex flex-wrap items-center gap-3">
				<div className="relative min-w-[14rem] flex-1">
					<Search
						className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("aiAccounts.search")}
						aria-label={t("aiAccounts.search")}
						className="pl-9"
					/>
				</div>
				<fieldset aria-label={t("aiAccounts.filters.label")} className="m-0 min-w-0 border-0 p-0">
					<Chips>
						{filters.map((f) => (
							<Chip key={f} pressed={filter === f} onClick={() => setFilter(f)} dot={false}>
								{t(`aiAccounts.filters.${f}`)} · {counts[f]}
							</Chip>
						))}
					</Chips>
				</fieldset>
			</div>

			{groups.length === 0 ? (
				<EmptyStage icon={Search} title={t("aiAccounts.empty.title")} tone="muted">
					{t("aiAccounts.empty.body")}
				</EmptyStage>
			) : (
				groups.map((group) => (
					<section key={group.id} className="flex flex-col gap-3" aria-labelledby={`ai-accounts-${group.id}`}>
						<h4 id={`ai-accounts-${group.id}`} className="wp-kicker wp-faint">
							{t(`aiAccounts.groups.${group.id}`)} · {group.items.length}
						</h4>
						<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
							{group.items.map(({ provider }) => (
								<CleanProviderCard
									key={provider.id}
									provider={provider}
									isDefault={provider.id === defaultProvider}
									isTesting={testingProviders?.has(provider.id)}
									onConfigure={onConfigure}
									onTest={onTest}
									onSetDefault={onSetDefault}
									onManageAccounts={onManageAccounts}
								/>
							))}
						</div>
					</section>
				))
			)}
		</div>
	);
}
