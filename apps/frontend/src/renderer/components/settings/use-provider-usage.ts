/**
 * The usage the AI accounts page shows: per Claude account (the usage monitor's
 * profiles) and per other provider that reports one (Copilot premium requests,
 * Windsurf, Codex...). Live while the page is open.
 */
import type { ProfileUsageSummary, UsageSnapshot } from "@shared/types/agent";
import { isClaudeProvider } from "@shared/utils/task-engine";
import { useCallback, useEffect, useState } from "react";

export interface ProviderUsage {
	readonly sessionPercent?: number;
	readonly weeklyPercent?: number;
	readonly needsReauthentication?: boolean;
}

/** Providers whose usage is fetched fresh when the page opens. */
const LIVE_PROVIDERS = ["anthropic", "copilot"] as const;

function summaryOf(snapshot: UsageSnapshot): ProfileUsageSummary {
	return {
		profileId: snapshot.profileId,
		profileName: snapshot.profileName,
		profileEmail: snapshot.profileEmail,
		sessionPercent: snapshot.sessionPercent,
		weeklyPercent: snapshot.weeklyPercent,
		sessionResetTimestamp: snapshot.sessionResetTimestamp,
		weeklyResetTimestamp: snapshot.weeklyResetTimestamp,
		isAuthenticated: true,
		// A fresh snapshot with real usage means the account is not blocked.
		isRateLimited: false,
		availabilityScore: 100 - Math.max(snapshot.sessionPercent, snapshot.weeklyPercent),
		isActive: true,
		needsReauthentication: snapshot.needsReauthentication,
	};
}

export function useProviderUsage(isOpen: boolean) {
	const [claudeUsage, setClaudeUsage] = useState<Map<string, ProfileUsageSummary>>(new Map());
	const [providerUsage, setProviderUsage] = useState<Map<string, ProviderUsage>>(new Map());

	const onSnapshot = useCallback((snapshot: UsageSnapshot | null | undefined) => {
		if (!snapshot?.profileId) return;
		const provider = snapshot.providerName ?? "anthropic";
		if (isClaudeProvider(provider)) {
			setClaudeUsage((prev) => new Map(prev).set(snapshot.profileId, summaryOf(snapshot)));
		} else {
			setProviderUsage((prev) =>
				new Map(prev).set(provider, {
					sessionPercent: snapshot.sessionPercent,
					weeklyPercent: snapshot.weeklyPercent,
					needsReauthentication: snapshot.needsReauthentication,
				}),
			);
		}
	}, []);

	useEffect(() => {
		if (!isOpen) return;
		const api = globalThis.electronAPI;
		let cancelled = false;

		const load = async () => {
			try {
				const all = await api.requestAllProfilesUsage?.(true);
				if (!cancelled && all?.success && all.data) {
					setClaudeUsage(new Map(all.data.allProfiles.map((p) => [p.profileId, p])));
				}
			} catch (err) {
				console.warn("[AiAccounts] Failed to load profile usage:", err);
			}
			// A real fetch after the cached values: the monitor's cache can lag.
			await Promise.all(
				LIVE_PROVIDERS.map(async (provider) => {
					try {
						const fresh = await api.requestUsageUpdate?.(provider);
						if (!cancelled && fresh?.success) onSnapshot(fresh.data);
					} catch (err) {
						console.warn(`[AiAccounts] Failed to fetch ${provider} usage:`, err);
					}
				}),
			);
			try {
				// Windsurf answers on demand; the rest is what the credential manager holds.
				api.invoke?.("usage:getData", "windsurf").catch(() => undefined);
				const cached = (await api.invoke?.("usage:getAllData")) as
					| Record<string, { usage?: ProviderUsage }>
					| undefined;
				if (!cancelled && cached) {
					setProviderUsage((prev) => {
						const next = new Map(prev);
						for (const [provider, data] of Object.entries(cached)) {
							if (data?.usage && !next.has(provider)) next.set(provider, data.usage);
						}
						return next;
					});
				}
			} catch (err) {
				console.warn("[AiAccounts] Failed to load provider usage:", err);
			}
		};
		void load();

		const offUsage = api.onUsageUpdated?.(onSnapshot);
		const offAll = api.onAllProfilesUsageUpdated?.((all: { allProfiles: ProfileUsageSummary[] }) => {
			setClaudeUsage((prev) => {
				const next = new Map(prev);
				for (const profile of all.allProfiles) {
					// The active account comes fresher from onUsageUpdated; the
					// all-profiles cache can lag behind the live poll.
					if (!profile.isActive) next.set(profile.profileId, profile);
				}
				return next;
			});
		});
		return () => {
			cancelled = true;
			offUsage?.();
			offAll?.();
		};
	}, [isOpen, onSnapshot]);

	return { claudeUsage, providerUsage };
}
