/**
 * The accounts of one provider, opened from its card in Settings → AI
 * accounts: Claude's OAuth profiles, the API-key accounts of the other
 * providers, and the sign-ins of the coding-agent CLIs (OpenAI's card shows
 * its keys and Codex CLI's sign-ins). A provider that signs in through
 * another tool (an IDE) keeps the one account that tool is signed in with.
 */

import { accountProviderOf, loginProviderOf } from "@shared/types/ai-accounts";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Notice } from "../../charter";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { ApiKeyAccounts } from "./ApiKeyAccounts";
import { ClaudeAccounts } from "./ClaudeAccounts";
import { LoginAccounts } from "./LoginAccounts";

/** Whether a provider's accounts are managed here (Claude, API keys, or a CLI's sign-ins). */
export function supportsAccounts(providerId: string): boolean {
	return (
		isClaudeAccounts(providerId) ||
		accountProviderOf(providerId) !== undefined ||
		loginProviderOf(providerId) !== undefined
	);
}

function isClaudeAccounts(providerId: string): boolean {
	return providerId === "anthropic" || providerId === "claude";
}

interface ProviderAccountsDialogProps {
	readonly provider: { id: string; name: string } | null;
	readonly onOpenChange: (open: boolean) => void;
}

export function ProviderAccountsDialog({ provider, onOpenChange }: ProviderAccountsDialogProps) {
	const { t } = useTranslation("settings");
	const accountProvider = provider ? accountProviderOf(provider.id) : undefined;
	const loginProvider = provider ? loginProviderOf(provider.id) : undefined;
	return (
		<Dialog open={provider !== null} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] max-w-[760px] overflow-y-auto">
				{provider && (
					<>
						<DialogHeader>
							<DialogTitle>{t("aiAccounts.accounts.title", { provider: provider.name })}</DialogTitle>
							<DialogDescription>{t("aiAccounts.accounts.description")}</DialogDescription>
						</DialogHeader>
						{isClaudeAccounts(provider.id) && <ClaudeAccounts />}
						{accountProvider && <ApiKeyAccounts provider={accountProvider} providerName={provider.name} />}
						{loginProvider && <LoginAccounts provider={loginProvider} />}
						{!supportsAccounts(provider.id) && (
							<Notice tone="muted" icon={Info}>
								{t("aiAccounts.accounts.singleAccount", { provider: provider.name })}
							</Notice>
						)}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
