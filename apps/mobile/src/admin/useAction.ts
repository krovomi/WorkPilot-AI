/** One action at a time on a screen: which one is running, and the last failure as a sentence. */

import { useCallback, useState } from "react";
import { describeError } from "../i18n";

export function useAction() {
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const run = useCallback(async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
		setBusy(key);
		setError(null);
		try {
			await action();
			return true;
		} catch (err) {
			setError(describeError(err));
			return false;
		} finally {
			setBusy(null);
		}
	}, []);
	return { busy, error, run, setError };
}
