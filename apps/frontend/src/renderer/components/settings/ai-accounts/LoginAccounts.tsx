/**
 * The accounts of a coding-agent CLI (GitHub CLI for Copilot, Codex CLI,
 * Gemini CLI): each signs in in a folder of its own, created by the main
 * process (`main/ai-accounts/login-accounts.ts`). The sign-in terminal runs
 * the command and folder the main process hands back; no key is stored. The
 * default account is the one tasks run on; without one, the CLI keeps the
 * sign-in of this computer.
 */

import { type AiAccountSignIn, type AiAccountView, LOGIN_CLI_NAMES } from "@shared/types/ai-accounts";
import { Check, Loader2, LogIn, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Button, Input, Label } from "@/components/ui";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { aiAccountsOf, useAiAccountsStore } from "@/stores/ai-accounts-store";
import { Chip, Notice } from "../../charter";
import { AuthTerminal } from "../AuthTerminal";

interface SignIn extends AiAccountSignIn {
	name: string;
}

interface LoginAccountsProps {
	/** A provider of `AI_LOGIN_PROVIDERS`. */
	readonly provider: string;
}

export function LoginAccounts({ provider }: LoginAccountsProps) {
	const { t } = useTranslation("settings");
	const cli = LOGIN_CLI_NAMES[provider] ?? provider;
	const { accounts, defaults, loaded, load, save, remove, setDefault, signIn } = useAiAccountsStore(
		useShallow((s) => ({
			accounts: s.accounts,
			defaults: s.defaults,
			loaded: s.loaded,
			load: s.load,
			save: s.save,
			remove: s.remove,
			setDefault: s.setDefault,
			signIn: s.signIn,
		})),
	);
	const [newName, setNewName] = useState("");
	const [adding, setAdding] = useState(false);
	const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [terminal, setTerminal] = useState<SignIn | null>(null);

	useEffect(() => {
		if (!loaded) void load();
	}, [loaded, load]);

	const mine = aiAccountsOf(accounts, provider);
	const defaultId = defaults[provider];

	const startSignIn = async (account: Pick<AiAccountView, "id" | "name">) => {
		setBusy(account.id);
		setError(null);
		try {
			const result = await signIn(account.id);
			if (result.plan) setTerminal({ ...result.plan, name: account.name });
			else setError(result.error || t("aiAccounts.accounts.login.signInFailed"));
		} catch (err) {
			setError(err instanceof Error ? err.message : t("aiAccounts.accounts.login.signInFailed"));
		} finally {
			setBusy(null);
		}
	};

	const closeTerminal = () => {
		setTerminal(null);
		// The CLI wrote its sign-in (or not): the list says which.
		void load();
	};

	const add = async () => {
		const name = newName.trim();
		if (!name) return;
		setBusy("add");
		setError(null);
		const result = await save({ provider, name });
		setBusy(null);
		if (!result.account) {
			setError(result.error || t("aiAccounts.accounts.saveFailed"));
			return;
		}
		setNewName("");
		setAdding(false);
		await startSignIn(result.account);
	};

	const rename = async () => {
		const name = renaming?.name.trim();
		if (!renaming || !name) return;
		setBusy(renaming.id);
		setError(null);
		const result = await save({ id: renaming.id, provider, name });
		setBusy(null);
		if (result.account) setRenaming(null);
		else setError(result.error || t("aiAccounts.accounts.saveFailed"));
	};

	const makeDefault = async (id: string | null) => {
		setBusy(id ?? "system");
		setError(null);
		const refused = await setDefault(provider, id);
		setBusy(null);
		if (refused) setError(refused);
		// The header's usage follows the new account.
		else globalThis.electronAPI.requestAllProfilesUsage?.();
	};

	const removeAccount = async (account: AiAccountView) => {
		const confirmed = await confirmAction({
			title: t("aiAccounts.accounts.deleteTitle", { name: account.name }),
			description: t("aiAccounts.accounts.login.deleteDescription", { cli }),
			destructive: true,
		});
		if (!confirmed) return;
		setBusy(account.id);
		setError(null);
		const refused = await remove(account.id);
		setBusy(null);
		if (refused) setError(refused);
	};

	return (
		<section className="space-y-3" data-testid="login-accounts" data-provider={provider}>
			<h3 className="text-sm font-semibold">{t("aiAccounts.accounts.login.title", { cli })}</h3>
			<p className="text-sm text-muted-foreground">{t("aiAccounts.accounts.login.intro", { cli })}</p>
			{error && (
				<Notice tone="red" role="alert">
					{error}
				</Notice>
			)}

			<div
				data-testid="ai-account"
				data-account="system"
				className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
			>
				<div className="min-w-0 flex-1 space-y-0.5">
					<div className="flex items-center gap-2 text-sm font-medium">
						<span className="truncate">{t("aiAccounts.accounts.login.system")}</span>
						{!defaultId && (
							<Chip tone="accent" dot={false}>
								{t("aiAccounts.accounts.default")}
							</Chip>
						)}
					</div>
					<p className="text-xs text-muted-foreground">{t("aiAccounts.accounts.login.systemHint", { cli })}</p>
				</div>
				{defaultId && (
					<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => makeDefault(null)}>
						<Star className="mr-2 h-4 w-4" />
						{t("aiAccounts.accounts.useByDefault")}
					</Button>
				)}
			</div>

			{mine.map((account) => {
				const isDefault = account.id === defaultId;
				const signedIn = account.signedIn === true;
				const isRenaming = renaming?.id === account.id;
				return (
					<div
						key={account.id}
						data-testid="ai-account"
						data-account={account.id}
						className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
					>
						<div className="min-w-0 flex-1 space-y-0.5">
							{isRenaming ? (
								<form
									className="flex items-center gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										void rename();
									}}
								>
									<Input
										aria-label={t("aiAccounts.accounts.name")}
										value={renaming.name}
										maxLength={80}
										autoFocus
										onChange={(event) => setRenaming({ id: account.id, name: event.target.value })}
									/>
									<Button type="submit" size="sm" variant="outline" aria-label={t("aiAccounts.accounts.save")}>
										<Check className="h-4 w-4" />
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										aria-label={t("aiAccounts.accounts.cancel")}
										onClick={() => setRenaming(null)}
									>
										<X className="h-4 w-4" />
									</Button>
								</form>
							) : (
								<div className="flex items-center gap-2 text-sm font-medium">
									<span className="truncate">{account.name}</span>
									{isDefault && (
										<Chip tone="accent" dot={false}>
											{t("aiAccounts.accounts.default")}
										</Chip>
									)}
								</div>
							)}
							<p className={signedIn ? "text-xs text-muted-foreground" : "text-xs text-warning"}>
								{signedIn ? t("aiAccounts.accounts.login.signedIn") : t("aiAccounts.accounts.login.signedOut")}
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							{!isDefault && signedIn && (
								<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => makeDefault(account.id)}>
									<Star className="mr-2 h-4 w-4" />
									{t("aiAccounts.accounts.useByDefault")}
								</Button>
							)}
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null || terminal !== null}
								onClick={() => startSignIn(account)}
							>
								{busy === account.id ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<LogIn className="mr-2 h-4 w-4" />
								)}
								{signedIn ? t("aiAccounts.accounts.login.reconnect") : t("aiAccounts.accounts.login.signIn")}
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null}
								aria-label={t("aiAccounts.accounts.rename", { name: account.name })}
								onClick={() => setRenaming({ id: account.id, name: account.name })}
							>
								<Pencil className="h-4 w-4" />
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null}
								aria-label={t("aiAccounts.accounts.delete", { name: account.name })}
								onClick={() => removeAccount(account)}
							>
								<Trash2 className="h-4 w-4" />
							</Button>
						</div>
					</div>
				);
			})}

			{terminal && (
				<div className="h-80 overflow-hidden rounded-lg border border-border">
					<AuthTerminal
						terminalId={terminal.terminalId}
						configDir=""
						profileName={terminal.name}
						loginCommand={terminal.command}
						env={terminal.env}
						instructions={{
							title: t("aiAccounts.accounts.login.terminalTitle", { cli, name: terminal.name }),
							steps: [
								t("aiAccounts.accounts.login.stepRun"),
								t("aiAccounts.accounts.login.stepFollow"),
								t("aiAccounts.accounts.login.stepClose"),
							],
						}}
						onClose={closeTerminal}
						onAuthSuccess={closeTerminal}
					/>
				</div>
			)}

			{adding ? (
				<form
					className="space-y-3 rounded-lg border border-border p-4"
					onSubmit={(event) => {
						event.preventDefault();
						void add();
					}}
				>
					<div className="space-y-2">
						<Label htmlFor={`login-account-name-${provider}`}>{t("aiAccounts.accounts.name")}</Label>
						<Input
							id={`login-account-name-${provider}`}
							value={newName}
							maxLength={80}
							placeholder={t("aiAccounts.accounts.namePlaceholder")}
							onChange={(event) => setNewName(event.target.value)}
						/>
					</div>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="outline" disabled={busy === "add"} onClick={() => setAdding(false)}>
							{t("aiAccounts.accounts.cancel")}
						</Button>
						<Button type="submit" disabled={busy === "add" || !newName.trim()}>
							{busy === "add" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
							{t("aiAccounts.accounts.login.addAndSignIn")}
						</Button>
					</div>
				</form>
			) : (
				<Button variant="outline" onClick={() => setAdding(true)} disabled={terminal !== null}>
					<Plus className="mr-2 h-4 w-4" />
					{t("aiAccounts.accounts.add")}
				</Button>
			)}
		</section>
	);
}
