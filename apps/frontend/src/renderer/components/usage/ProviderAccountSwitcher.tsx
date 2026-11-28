/**
 * The other accounts of the provider the usage popover shows (OpenAI,
 * Mistral, OpenRouter, Copilot, Gemini CLI…), one click from becoming its
 * default: the next task, test or view of that provider runs on it. A
 * provider can list two groups: its API keys, and the sign-ins of its CLI
 * (OpenAI's keys and Codex CLI's sign-ins). Claude's accounts keep their own
 * list in the popover (its OAuth profiles, with their usage). Each account
 * shows what it spent this month (`main/ai-accounts/account-usage.ts`).
 */

import { accountProviderOf, loginProviderOf } from "@shared/types/ai-accounts";
import { KeyRound, LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { formatUsd } from "@/components/administration/usage/usage-format";
import { useAiAccountUsageStore } from "@/stores/ai-account-usage-store";
import { aiAccountsOf, useAiAccountsStore } from "@/stores/ai-accounts-store";

interface ProviderAccountSwitcherProps {
	/** The provider the popover shows. */
	readonly provider: string | null | undefined;
}

/** The main key of a provider, or a CLI's sign-in of this computer, is listed under this id. */
const MAIN = "main";

interface Group {
	provider: string;
	kind: "key" | "login";
	entries: { id: string; name: string }[];
}

export function ProviderAccountSwitcher({ provider }: ProviderAccountSwitcherProps) {
	const { t } = useTranslation(["common", "settings"]);
	const accountProvider = accountProviderOf(provider);
	const loginProvider = loginProviderOf(provider);
	const { accounts, defaults, mainKeys } = useAiAccountsStore(
		useShallow((s) => ({ accounts: s.accounts, defaults: s.defaults, mainKeys: s.mainKeys })),
	);
	const [switching, setSwitching] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const hasAccounts = accountProvider !== undefined || loginProvider !== undefined;
	const spend = useAiAccountUsageStore((s) => s.accounts);

	useEffect(() => {
		if (!hasAccounts) return;
		void useAiAccountsStore.getState().load();
		void useAiAccountUsageStore.getState().load();
	}, [hasAccounts]);

	const groups: Group[] = [];
	if (accountProvider) {
		groups.push({
			provider: accountProvider,
			kind: "key",
			entries: [
				...(mainKeys.includes(accountProvider)
					? [{ id: MAIN, name: t("settings:aiAccounts.accounts.mainKey") }]
					: []),
				...aiAccountsOf(accounts, accountProvider)
					.filter((account) => account.hasKey)
					.map((account) => ({ id: account.id, name: account.name })),
			],
		});
	}
	if (loginProvider) {
		groups.push({
			provider: loginProvider,
			kind: "login",
			entries: [
				{ id: MAIN, name: t("settings:aiAccounts.accounts.login.system") },
				...aiAccountsOf(accounts, loginProvider)
					.filter((account) => account.signedIn === true)
					.map((account) => ({ id: account.id, name: account.name })),
			],
		});
	}
	// One account leaves nothing to switch to.
	const shown = groups.filter((group) => group.entries.length >= 2);
	if (shown.length === 0) return null;

	const switchTo = async (group: Group, id: string) => {
		setSwitching(`${group.provider}:${id}`);
		const refused = await useAiAccountsStore.getState().setDefault(group.provider, id === MAIN ? null : id);
		setError(refused);
		setSwitching(null);
	};

	return (
		<div className="space-y-1 border-t pt-2" data-testid="provider-account-switcher">
			<div className="mb-1.5 text-3xs font-medium text-muted-foreground">
				{t("common:usage.providerAccounts")}
			</div>
			{shown.map((group) => {
				const activeId = defaults[group.provider] ?? MAIN;
				const Icon = group.kind === "login" ? LogIn : KeyRound;
				return group.entries.map((entry) => {
					const isActive = entry.id === activeId;
					return (
						<button
							key={`${group.provider}:${entry.id}`}
							type="button"
							disabled={isActive || switching !== null}
							aria-pressed={isActive}
							data-group={group.kind}
							onClick={(event) => {
								event.stopPropagation();
								void switchTo(group, entry.id);
							}}
							className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
								isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted/50 text-foreground"
							}`}
						>
							<Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.name}</span>
							{spend[entry.id] && spend[entry.id].costUsd > 0 && (
								<span
									className="text-3xs tabular-nums opacity-80"
									title={t("settings:aiAccounts.spend.monthShort")}
								>
									{formatUsd(spend[entry.id].costUsd)}
								</span>
							)}
							<span
								className={`rounded-md px-2 py-0.5 text-3xs ${
									isActive ? "bg-primary-foreground/20" : "bg-primary/10 text-primary"
								}`}
							>
								{isActive ? t("common:usage.activeAccount") : t("common:usage.setActive")}
							</span>
						</button>
					);
				});
			})}
			{error && (
				<p role="alert" className="text-3xs text-destructive">
					{t("common:usage.accountSwitchFailed", { error })}
				</p>
			)}
		</div>
	);
}
