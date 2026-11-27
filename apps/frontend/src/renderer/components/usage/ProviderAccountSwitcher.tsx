/**
 * The other accounts of the provider the usage popover shows (OpenAI,
 * Mistral, OpenRouter…), one click from becoming its default: the next task,
 * test or view of that provider runs on it. Claude's accounts keep their own
 * list in the popover (its OAuth profiles, with their usage).
 */

import { accountProviderOf } from "@shared/types/ai-accounts";
import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { aiAccountsOf, useAiAccountsStore } from "@/stores/ai-accounts-store";

interface ProviderAccountSwitcherProps {
	/** The provider the popover shows. */
	readonly provider: string | null | undefined;
}

/** The main key of a provider is listed under this id. */
const MAIN_KEY = "main";

export function ProviderAccountSwitcher({ provider }: ProviderAccountSwitcherProps) {
	const { t } = useTranslation(["common", "settings"]);
	const accountProvider = accountProviderOf(provider);
	const { accounts, defaults, mainKeys } = useAiAccountsStore(
		useShallow((s) => ({ accounts: s.accounts, defaults: s.defaults, mainKeys: s.mainKeys })),
	);
	const [switching, setSwitching] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (accountProvider) void useAiAccountsStore.getState().load();
	}, [accountProvider]);

	if (!accountProvider) return null;
	const entries = [
		...(mainKeys.includes(accountProvider)
			? [{ id: MAIN_KEY, name: t("settings:aiAccounts.accounts.mainKey") }]
			: []),
		...aiAccountsOf(accounts, accountProvider)
			.filter((account) => account.hasKey)
			.map((account) => ({ id: account.id, name: account.name })),
	];
	// One account leaves nothing to switch to.
	if (entries.length < 2) return null;
	const activeId = defaults[accountProvider] ?? MAIN_KEY;

	const switchTo = async (id: string) => {
		setSwitching(id);
		const refused = await useAiAccountsStore
			.getState()
			.setDefault(accountProvider, id === MAIN_KEY ? null : id);
		setError(refused);
		setSwitching(null);
	};

	return (
		<div className="space-y-1 border-t pt-2" data-testid="provider-account-switcher">
			<div className="mb-1.5 text-3xs font-medium text-muted-foreground">
				{t("common:usage.providerAccounts")}
			</div>
			{entries.map((entry) => {
				const isActive = entry.id === activeId;
				return (
					<button
						key={entry.id}
						type="button"
						disabled={isActive || switching !== null}
						aria-pressed={isActive}
						onClick={(event) => {
							event.stopPropagation();
							void switchTo(entry.id);
						}}
						className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
							isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted/50 text-foreground"
						}`}
					>
						<KeyRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
						<span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.name}</span>
						<span
							className={`rounded-md px-2 py-0.5 text-3xs ${
								isActive ? "bg-primary-foreground/20" : "bg-primary/10 text-primary"
							}`}
						>
							{isActive ? t("common:usage.activeAccount") : t("common:usage.setActive")}
						</span>
					</button>
				);
			})}
			{error && (
				<p role="alert" className="text-3xs text-destructive">
					{t("common:usage.accountSwitchFailed", { error })}
				</p>
			)}
		</div>
	);
}
