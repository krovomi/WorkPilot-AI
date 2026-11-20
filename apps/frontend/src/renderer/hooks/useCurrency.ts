import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getEurRate, knownEurRate } from "../lib/currency";

/**
 * The USD→EUR rate for a page that shows costs with `formatCurrency`.
 *
 * One source and one cache for the whole app (`lib/currency.ts`): this hook
 * used to ask a second exchange-rate service of its own, so two pages could
 * show the same cost at two rates. Only French needs the rate; English shows
 * dollars and asks nothing.
 */
export function useCurrency(): { rate: number } {
	const { i18n } = useTranslation();
	const needsRate = i18n.language.startsWith("fr");
	const [rate, setRate] = useState(knownEurRate);

	useEffect(() => {
		if (!needsRate) return;
		let live = true;
		void getEurRate().then((value) => {
			if (live) setRate(value);
		});
		return () => {
			live = false;
		};
	}, [needsRate]);

	return { rate };
}
