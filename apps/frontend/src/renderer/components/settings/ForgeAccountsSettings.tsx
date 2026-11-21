/**
 * The forge accounts saved for the whole app: several GitHub, GitLab, Azure
 * DevOps and Bitbucket accounts ("Work", "Client X"), each project picking the
 * one it works with in its own settings. A token is typed here and sent once:
 * the main process keeps it encrypted and only says whether one is set
 * (`main/forge/forge-accounts.ts`); the connection test runs there too.
 */

import { Check, KeyRound, Loader2, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@/components/ui";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { NativeSelect } from "@/components/ui/native-select";
import {
	FORGE_KINDS,
	type ForgeAccountInput,
	type ForgeAccountTestResult,
	type ForgeAccountView,
	type ForgeKind,
} from "@shared/types/forge-accounts";
import { useForgeAccountsStore } from "../../stores/forge-accounts-store";
import { Notice } from "../charter";
import { SettingsSection } from "./SettingsSection";

export const FORGE_NAMES: Readonly<Record<ForgeKind, string>> = {
	github: "GitHub",
	gitlab: "GitLab",
	azure_devops: "Azure DevOps",
	bitbucket: "Bitbucket",
};

/** Forges whose token is valid for an address the person gives. */
const NEEDS_HOST: ReadonlySet<ForgeKind> = new Set(["gitlab", "azure_devops"]);

interface Draft {
	id?: string;
	forge: ForgeKind;
	label: string;
	host: string;
	username: string;
	token: string;
	hasToken: boolean;
}

const EMPTY: Draft = { forge: "github", label: "", host: "", username: "", token: "", hasToken: false };

function draftOf(account: ForgeAccountView): Draft {
	return {
		id: account.id,
		forge: account.forge,
		label: account.label,
		host: NEEDS_HOST.has(account.forge) ? account.host : "",
		username: account.username ?? "",
		token: "",
		hasToken: account.hasToken,
	};
}

function inputOf(draft: Draft): ForgeAccountInput {
	return {
		...(draft.id ? { id: draft.id } : {}),
		forge: draft.forge,
		label: draft.label,
		host: NEEDS_HOST.has(draft.forge) ? draft.host : undefined,
		username: draft.username || undefined,
		// Nothing typed keeps the saved token.
		token: draft.token ? draft.token : undefined,
	};
}

function AccountForm({
	draft,
	onChange,
	onSubmit,
	onCancel,
	busy,
}: {
	draft: Draft;
	onChange: (draft: Draft) => void;
	onSubmit: () => void;
	onCancel: () => void;
	busy: boolean;
}) {
	const { t } = useTranslation("settings");
	const editing = draft.id !== undefined;
	return (
		<div className="space-y-3 rounded-lg border border-border p-4">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="forge-account-forge">{t("forgeAccounts.forge")}</Label>
					<NativeSelect
						id="forge-account-forge"
						className="w-full"
						value={draft.forge}
						disabled={editing}
						onChange={(e) => onChange({ ...draft, forge: e.target.value as ForgeKind })}
					>
						{FORGE_KINDS.map((forge) => (
							<option key={forge} value={forge}>
								{FORGE_NAMES[forge]}
							</option>
						))}
					</NativeSelect>
				</div>
				<div className="space-y-2">
					<Label htmlFor="forge-account-label">{t("forgeAccounts.label")}</Label>
					<Input
						id="forge-account-label"
						value={draft.label}
						placeholder={t("forgeAccounts.labelPlaceholder")}
						onChange={(e) => onChange({ ...draft, label: e.target.value })}
					/>
				</div>
				{NEEDS_HOST.has(draft.forge) && (
					<div className="space-y-2 sm:col-span-2">
						<Label htmlFor="forge-account-host">
							{t(draft.forge === "gitlab" ? "forgeAccounts.gitlabHost" : "forgeAccounts.azureHost")}
						</Label>
						<Input
							id="forge-account-host"
							value={draft.host}
							placeholder={
								draft.forge === "gitlab" ? "https://gitlab.com" : "https://dev.azure.com/org"
							}
							onChange={(e) => onChange({ ...draft, host: e.target.value })}
						/>
					</div>
				)}
				{draft.forge === "bitbucket" && (
					<div className="space-y-2 sm:col-span-2">
						<Label htmlFor="forge-account-username">{t("forgeAccounts.bitbucketUsername")}</Label>
						<Input
							id="forge-account-username"
							value={draft.username}
							autoComplete="off"
							onChange={(e) => onChange({ ...draft, username: e.target.value })}
						/>
						<p className="text-xs text-muted-foreground">{t("forgeAccounts.bitbucketUsernameHint")}</p>
					</div>
				)}
				<div className="space-y-2 sm:col-span-2">
					<Label htmlFor="forge-account-token">{t("forgeAccounts.token")}</Label>
					<Input
						id="forge-account-token"
						type="password"
						autoComplete="off"
						value={draft.token}
						placeholder={
							draft.hasToken ? t("forgeAccounts.tokenKeep") : t("forgeAccounts.tokenPlaceholder")
						}
						onChange={(e) => onChange({ ...draft, token: e.target.value })}
					/>
				</div>
			</div>
			<div className="flex justify-end gap-2">
				<Button variant="outline" onClick={onCancel} disabled={busy}>
					{t("forgeAccounts.cancel")}
				</Button>
				<Button onClick={onSubmit} disabled={busy || !draft.label.trim()}>
					{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
					{t("forgeAccounts.save")}
				</Button>
			</div>
		</div>
	);
}

export function ForgeAccountsSettings() {
	const { t } = useTranslation("settings");
	const accounts = useForgeAccountsStore((s) => s.accounts);
	const loadError = useForgeAccountsStore((s) => s.error);
	const load = useForgeAccountsStore((s) => s.load);
	const save = useForgeAccountsStore((s) => s.save);
	const remove = useForgeAccountsStore((s) => s.remove);
	const test = useForgeAccountsStore((s) => s.test);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tests, setTests] = useState<Record<string, ForgeAccountTestResult>>({});

	useEffect(() => {
		void load();
	}, [load]);

	const submit = async () => {
		if (!draft) return;
		setBusy("form");
		setError(null);
		const result = await save(inputOf(draft));
		setBusy(null);
		if (result.error) setError(result.error);
		else setDraft(null);
	};

	const runTest = async (id: string) => {
		setBusy(id);
		const result = await test(id);
		setTests((current) => ({ ...current, [id]: result }));
		setBusy(null);
	};

	const confirmRemove = async (account: ForgeAccountView) => {
		const confirmed = await confirmAction({
			title: t("forgeAccounts.deleteTitle", { label: account.label }),
			description: t("forgeAccounts.deleteDescription"),
			destructive: true,
		});
		if (!confirmed) return;
		setError(await remove(account.id));
	};

	return (
		<SettingsSection title={t("forgeAccounts.title")} description={t("forgeAccounts.description")}>
			{(error || loadError) && (
				<Notice tone="red" role="alert">
					{error || loadError}
				</Notice>
			)}
			<div className="space-y-3">
				{accounts.length === 0 && !draft && (
					<p className="text-sm text-muted-foreground">{t("forgeAccounts.empty")}</p>
				)}
				{accounts.map((account) => {
					const result = tests[account.id];
					return (
						<div
							key={account.id}
							data-testid="forge-account"
							className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center"
						>
							<div className="min-w-0 flex-1 space-y-1">
								<div className="flex items-center gap-2 font-medium">
									<KeyRound className="h-4 w-4" />
									<span className="truncate">{account.label}</span>
									<span className="text-xs text-muted-foreground">{FORGE_NAMES[account.forge]}</span>
								</div>
								<div className="flex gap-2 truncate text-xs text-muted-foreground">
									{account.username && <span>{account.username}</span>}
									<span>{account.host}</span>
								</div>
								<div className="text-xs">
									{account.hasToken ? (
										<span className="flex items-center gap-1 text-success">
											<Check className="h-3 w-3" />
											{t("forgeAccounts.tokenSet")}
										</span>
									) : (
										<span className="text-warning">{t("forgeAccounts.noToken")}</span>
									)}
								</div>
								{result && (
									<div
										role="status"
										className={result.ok ? "text-xs text-success" : "text-xs text-destructive"}
									>
										{result.ok
											? t("forgeAccounts.testOk", { username: result.username })
											: t("forgeAccounts.testFailed", { error: result.error ?? "" })}
									</div>
								)}
							</div>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => runTest(account.id)}
									disabled={busy !== null || !account.hasToken}
								>
									{busy === account.id ? (
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									) : (
										<Plug className="mr-2 h-4 w-4" />
									)}
									{t("forgeAccounts.test")}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setDraft(draftOf(account))}
									disabled={busy !== null}
									aria-label={t("forgeAccounts.edit", { label: account.label })}
								>
									<Pencil className="h-4 w-4" />
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => confirmRemove(account)}
									disabled={busy !== null}
									aria-label={t("forgeAccounts.delete", { label: account.label })}
								>
									<Trash2 className="h-4 w-4" />
								</Button>
							</div>
						</div>
					);
				})}
				{draft ? (
					<AccountForm
						draft={draft}
						onChange={setDraft}
						onSubmit={submit}
						onCancel={() => {
							setDraft(null);
							setError(null);
						}}
						busy={busy === "form"}
					/>
				) : (
					<Button variant="outline" onClick={() => setDraft({ ...EMPTY })}>
						<Plus className="mr-2 h-4 w-4" />
						{t("forgeAccounts.add")}
					</Button>
				)}
			</div>
		</SettingsSection>
	);
}
