/**
 * The live model list of a gateway (OpenRouter, Hugging Face), on its provider
 * page: the models it serves with tool calling, their price and context window,
 * and a click to make one the default model. The list comes from the backend
 * (`/providers/models/<gateway>/catalog`), which reads the gateway's own
 * `/models`, so no key is needed to browse it.
 */
import { CircleCheck, Loader2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type GatewayProviderId,
	gatewayProvider,
} from "../../../shared/constants/gateway-providers";
import { useProviderModelCatalog } from "../../hooks/useProviderModelCatalog";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { contextLabel, filterCatalog, priceLabel } from "./gateway-model-catalog";

/** Rows drawn at once: the OpenRouter list holds several hundred models. */
const MAX_ROWS = 40;

interface GatewayModelCatalogProps {
	readonly provider: GatewayProviderId;
	readonly selectedModel?: string;
	readonly onSelectModel: (model: string) => void;
	readonly className?: string;
}

export function GatewayModelCatalog({
	provider,
	selectedModel,
	onSelectModel,
	className,
}: GatewayModelCatalogProps) {
	const { t } = useTranslation("settings");
	const tc = (key: string, opts?: Record<string, unknown>) =>
		t(`sections.accounts.gatewayCatalog.${key}`, opts ?? {});
	const name = gatewayProvider(provider)?.label ?? provider;
	const { models, source, loading } = useProviderModelCatalog(provider);
	const [query, setQuery] = useState("");
	const matches = useMemo(() => filterCatalog(models, query), [models, query]);
	const shown = matches.slice(0, MAX_ROWS);
	const selected = selectedModel?.trim().toLowerCase();

	return (
		<div className={cn("space-y-2", className)}>
			<div>
				<p className="text-sm font-medium text-foreground">
					{tc("title", { name })}
				</p>
				<p className="text-xs text-muted-foreground">
					{tc("description", { name })}
				</p>
			</div>
			<div className="relative">
				<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
				<Input
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={tc("searchPlaceholder")}
					className="w-full pl-8 py-1.5 text-sm h-auto"
				/>
			</div>
			{source === "static" && !loading && (
				<p className="text-xs text-warning">{tc("offline", { name })}</p>
			)}
			{loading && models.length === 0 && (
				<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<Loader2 className="h-3.5 w-3.5 animate-spin" />
					{tc("loading")}
				</p>
			)}
			{!loading && matches.length === 0 && (
				<p className="text-xs text-muted-foreground">{tc("empty")}</p>
			)}
			<div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
				{shown.map((model) => {
					const isSelected = model.value.toLowerCase() === selected;
					const price = priceLabel(model);
					const context = contextLabel(model.contextWindow);
					return (
						<button
							key={model.value}
							type="button"
							aria-pressed={isSelected}
							title={tc("setDefault", { id: model.value })}
							onClick={() => onSelectModel(model.value)}
							className={cn(
								"flex w-full items-center justify-between gap-3 rounded-md border p-2 text-left hover:bg-muted/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
								isSelected ? "border-primary bg-primary/5" : "border-border",
							)}
						>
							<span className="min-w-0">
								<span className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
									{isSelected && (
										<CircleCheck className="h-4 w-4 shrink-0 text-primary" />
									)}
									{model.label}
									{isSelected && (
										<span className="text-3xs font-normal text-primary">
											{tc("default")}
										</span>
									)}
								</span>
								<span className="block truncate text-2xs text-muted-foreground">
									{model.value}
								</span>
							</span>
							<span className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-2xs text-muted-foreground">
								{price && <span>{tc("price", { price })}</span>}
								{context && <span>{tc("context", { size: context })}</span>}
								{model.providerCount != null && (
									<span>{tc("providers", { count: model.providerCount })}</span>
								)}
							</span>
						</button>
					);
				})}
			</div>
			{matches.length > shown.length && (
				<p className="text-2xs text-muted-foreground">
					{tc("more", { count: matches.length - shown.length })}
				</p>
			)}
		</div>
	);
}
