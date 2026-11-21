/**
 * What a gateway's live catalogue says about a model: which Hub repos the
 * Hugging Face router serves (the « Try in the cloud » button of the model
 * search) and how a price reads. Pure, so the components stay thin.
 */
import type { CatalogModel } from "../../hooks/useProviderModelCatalog";

/** Catalogue entries by lower-cased id: Hub ids are case-insensitive. */
export function indexCatalog(
	models: readonly CatalogModel[],
): ReadonlyMap<string, CatalogModel> {
	const index = new Map<string, CatalogModel>();
	for (const model of models) {
		if (model.value && model.value !== "custom") {
			index.set(model.value.toLowerCase(), model);
		}
	}
	return index;
}

/** The catalogue entry for a Hub repo id, ignoring a `:policy` suffix. */
export function catalogEntry(
	index: ReadonlyMap<string, CatalogModel>,
	id: string,
): CatalogModel | undefined {
	return index.get(id.split(":")[0].toLowerCase());
}

/** `$0.24` for a price per million tokens; `0` reads `$0`; unknown is null. */
export function formatPerMillion(
	value: number | null | undefined,
): string | null {
	if (value == null || !Number.isFinite(value) || value < 0) return null;
	if (value === 0) return "$0";
	const digits = value >= 10 ? 1 : value >= 0.1 ? 2 : 3;
	return `$${Number(value.toFixed(digits))}`;
}

/** `$0.24 / $8.4` (input / output per million), or null without prices. */
export function priceLabel(model: CatalogModel | undefined): string | null {
	const input = formatPerMillion(model?.inputPrice);
	const output = formatPerMillion(model?.outputPrice);
	if (!input && !output) return null;
	return `${input ?? "?"} / ${output ?? "?"}`;
}

/** `256k` for a context window in tokens, or null. */
export function contextLabel(tokens: number | null | undefined): string | null {
	if (!tokens || tokens <= 0) return null;
	if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
	return `${Math.round(tokens / 1000)}k`;
}

/** Entries whose id or label holds every word of the query, in catalogue order. */
export function filterCatalog(
	models: readonly CatalogModel[],
	query: string,
): CatalogModel[] {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return models.filter((model) => {
		if (!model.value || model.value === "custom") return false;
		const text = `${model.value} ${model.label}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}
