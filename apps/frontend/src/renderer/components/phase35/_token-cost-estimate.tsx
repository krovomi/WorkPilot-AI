/**
 * Tiny widget that turns a token count into a localized cost estimate
 * for the active provider/model.
 *
 * - USD ↔ EUR conversion uses the cached rate of `getEurRate` (`_use-eur-rate.ts`).
 * - When the model is on a flat-rate plan (Cursor / Windsurf / Copilot / Ollama),
 *   we explicitly say so instead of pretending the cost is $0.00.
 * - When pricing is unknown for the (provider, model) pair we surface that
 *   as well — silent zeros are misleading.
 */

import { Info } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useActiveModel } from "../../hooks/useActiveModel";
import { formatCurrency } from "../../lib/currency";
import {
	estimateUsdCost,
	getModelPricing,
	isPerTokenBilled,
} from "../../lib/model-pricing";
import { useEurRate } from "./_use-eur-rate";

interface TokenCostEstimateProps {
	/** A budget the caller has already checked: whole and positive. */
	readonly totalTokens: number;
	/** 0–1 fraction of the budget assumed to come back as output. */
	readonly outputRatio?: number;
	/** Decimal places shown in the headline cost. Defaults to 4. */
	readonly decimals?: number;
}

export function TokenCostEstimate({
	totalTokens,
	outputRatio = 0.25,
	decimals = 4,
}: TokenCostEstimateProps) {
	const { t, i18n } = useTranslation("phase35");
	const { provider, model } = useActiveModel();
	const eurRate = useEurRate(i18n.language);


	const pricing = useMemo(() => getModelPricing(provider, model), [provider, model]);
	const flatRate = useMemo(
		() => Boolean(pricing) && !isPerTokenBilled(provider, model),
		[pricing, provider, model],
	);

	if (!model) {
		return (
			<p className="mt-1 text-xs text-muted-foreground italic">
				{t("cogContext.costNoModel")}
			</p>
		);
	}

	if (!pricing) {
		return (
			<p className="mt-1 text-xs text-muted-foreground italic">
				<Info className="inline h-3 w-3 mr-1" aria-hidden />
				{t("cogContext.costUnknown")}
				<span className="ml-1 font-mono opacity-70">
					({provider}/{model})
				</span>
			</p>
		);
	}

	if (flatRate) {
		return (
			<p className="mt-1 text-xs text-muted-foreground italic">
				<Info className="inline h-3 w-3 mr-1" aria-hidden />
				{t("cogContext.costFlatRate")}
				<span className="ml-1 font-mono opacity-70">
					({provider}/{pricing.model})
				</span>
			</p>
		);
	}

	const cost = estimateUsdCost(pricing, totalTokens, outputRatio);
	const formatted = formatCurrency(cost.total, i18n.language, eurRate, decimals);
	const inputFmt = formatCurrency(cost.input, i18n.language, eurRate, decimals);
	const outputFmt = formatCurrency(cost.output, i18n.language, eurRate, decimals);
	const ratioPct = Math.round(outputRatio * 100);

	const breakdown = t("cogContext.costBreakdown", {
		input: inputFmt,
		output: outputFmt,
		ratio: ratioPct,
	});
	const subtitle = t("cogContext.costFor", {
		provider,
		model: pricing.model,
	});

	return (
		<div className="mt-1 space-y-0.5 text-xs">
			<div className="flex items-baseline gap-2">
				<span className="font-medium">{t("cogContext.estimatedCost")}:</span>
				<span className="font-mono font-semibold">{formatted}</span>
			</div>
			<div className="text-muted-foreground" title={breakdown}>
				{subtitle}
			</div>
			<div className="text-muted-foreground/80 font-mono text-3xs">
				{breakdown}
			</div>
		</div>
	);
}
