import { useEffect, useState } from "react";
import { getEurRate, knownEurRate } from "../../lib/currency";

/**
 * The EUR/USD rate the costs are shown at in French. Asked only in French;
 * an answer that lands after the panel closed is harmless (React drops it).
 */
export function useEurRate(language: string): number {
	const [rate, setRate] = useState(knownEurRate);
	const isFr = language.startsWith("fr");
	useEffect(() => {
		if (isFr) void getEurRate().then(setRate);
	}, [isFr]);
	return rate;
}
