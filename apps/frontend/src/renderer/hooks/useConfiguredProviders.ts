import { useEffect, useState } from "react";
import { debugError } from "../../shared/utils/debug-logger";
import { getStaticProviders } from "../../shared/utils/providers";
import { useSettingsStore } from "../stores/settings-store";

export interface ConfiguredProvider {
	name: string;
	label: string;
}

/**
 * The providers this machine can actually run, as the "Comptes IA" page and
 * the task engine editor see them (`getStaticProviders`, `status === true`).
 *
 * `enabled` lets a caller wait until it is shown: the lookup asks the main
 * process about three OAuth logins, which a hidden panel has no reason to pay.
 */
export function useConfiguredProviders(enabled = true): {
	providers: ConfiguredProvider[];
	loading: boolean;
} {
	const settings = useSettingsStore((s) => s.settings);
	const profiles = useSettingsStore((s) => s.profiles);
	const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		setLoading(true);
		getStaticProviders(profiles, settings as unknown as Record<string, unknown>)
			.then((res) => {
				if (cancelled) return;
				setProviders(
					res.providers
						.filter((p) => res.status[p.name] === true)
						.map((p) => ({ name: p.name, label: p.label })),
				);
			})
			.catch((err) => {
				debugError("[useConfiguredProviders] getStaticProviders failed", err);
				if (!cancelled) setProviders([]);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, profiles, settings]);

	return { providers, loading };
}
