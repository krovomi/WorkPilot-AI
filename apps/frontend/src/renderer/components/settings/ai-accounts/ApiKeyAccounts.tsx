/**
 * The accounts of one API-key provider (OpenAI, Mistral, OpenRouter…): the
 * key typed on the provider's own page (its "main key") and the accounts saved
 * here, one of them the default that tasks, tests and views run on. A key is
 * typed once and sent to the main process, which keeps it encrypted and only
 * says whether one is set (`main/ai-accounts/ai-accounts.ts`); the
 * connection test runs there too, on the provider's own endpoint. An AWS
 * account is a key pair and a region (`KEY_PAIR_PROVIDERS`).
 */

import {
	type AiAccountTestResult,
	type AiAccountView,
	DEFAULT_AWS_REGION,
	KEY_PAIR_PROVIDERS,
} from "@shared/types/ai-accounts";
import { KeyRound, Loader2, Pencil, Plug, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@/components/ui";
import { confirmAction } from "@/components/ui/confirm-dialog";
import { formatAppDateTime } from "@/lib/date-format";
import { useAiAccountUsageStore } from "@/stores/ai-account-usage-store";
import { aiAccountsOf, useAiAccountsStore } from "@/stores/ai-accounts-store";
import { Chip, Notice } from "../../charter";
import { AccountSpend } from "./AccountSpend";

interface Draft {
	id?: string;
	name: string;
	apiKey: string;
	hasKey: boolean;
	/** A key-pair account (AWS): the secret typed, whether one is saved, the region. */
	secretKey: string;
	hasSecret: boolean;
	region: string;
}

const EMPTY: Draft = { name: "", apiKey: "", hasKey: false, secretKey: "", hasSecret: false, region: "" };

interface ApiKeyAccountsProps {
	readonly provider: string;
	readonly providerName: string;
}

function AccountForm({
	draft,
	pair,
	busy,
	onChange,
	onSubmit,
	onCancel,
}: {
	readonly draft: Draft;
	/** A key-pair provider (AWS): access key id, secret and region. */
	readonly pair: boolean;
	readonly busy: boolean;
	readonly onChange: (draft: Draft) => void;
	readonly onSubmit: () => void;
	readonly onCancel: () => void;
}) {
	const { t } = useTranslation("settings");
	const creating = draft.id === undefined;
	const missing = creating && (!draft.apiKey.trim() || (pair && !draft.secretKey.trim()));
	return (
		<form
			className="space-y-3 rounded-lg border border-border p-4"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="ai-account-name">{t("aiAccounts.accounts.name")}</Label>
					<Input
						id="ai-account-name"
						value={draft.name}
						maxLength={80}
						placeholder={t("aiAccounts.accounts.namePlaceholder")}
						onChange={(event) => onChange({ ...draft, name: event.target.value })}
					/>
				</div>
				<div className="space-y-2">
					<Label htmlFor="ai-account-key">
						{pair ? t("aiAccounts.accounts.keyId") : t("aiAccounts.accounts.key")}
					</Label>
					<Input
						id="ai-account-key"
						type="password"
						autoComplete="off"
						value={draft.apiKey}
						placeholder={
							draft.hasKey ? t("aiAccounts.accounts.keyKeep") : t("aiAccounts.accounts.keyPlaceholder")
						}
						onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
					/>
				</div>
				{pair && (
					<>
						<div className="space-y-2">
							<Label htmlFor="ai-account-secret">{t("aiAccounts.accounts.secretKey")}</Label>
							<Input
								id="ai-account-secret"
								type="password"
								autoComplete="off"
								value={draft.secretKey}
								placeholder={
									draft.hasSecret
										? t("aiAccounts.accounts.secretKeep")
										: t("aiAccounts.accounts.secretPlaceholder")
								}
								onChange={(event) => onChange({ ...draft, secretKey: event.target.value })}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="ai-account-region">{t("aiAccounts.accounts.region")}</Label>
							<Input
								id="ai-account-region"
								value={draft.region}
								maxLength={40}
								placeholder={DEFAULT_AWS_REGION}
								onChange={(event) => onChange({ ...draft, region: event.target.value })}
							/>
						</div>
					</>
				)}
			</div>
			<div className="flex justify-end gap-2">
				<Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
					{t("aiAccounts.accounts.cancel")}
				</Button>
				<Button
					type="submit"
					disabled={busy || !draft.name.trim() || missing}
				>
					{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
					{creating ? t("aiAccounts.accounts.addAndTest") : t("aiAccounts.accounts.save")}
				</Button>
			</div>
		</form>
	);
}

function TestLine({
	result,
	providerName,
}: {
	readonly result: AiAccountTestResult;
	readonly providerName: string;
}) {
	const { t } = useTranslation("settings");
	return (
		<p role="status" className={result.ok ? "text-xs text-success" : "text-xs text-destructive"}>
			{result.ok
				? result.unchecked
					? t("aiAccounts.accounts.testUnchecked", { provider: providerName })
					: result.modelCount
					? t("aiAccounts.accounts.testOkModels", { count: result.modelCount })
					: t("aiAccounts.accounts.testOk")
				: t("aiAccounts.accounts.testFailed", { error: result.error ?? "" })}
		</p>
	);
}

export function ApiKeyAccounts({ provider, providerName }: ApiKeyAccountsProps) {
	const { t } = useTranslation("settings");
	const allAccounts = useAiAccountsStore((s) => s.accounts);
	const defaults = useAiAccountsStore((s) => s.defaults);
	const mainKeys = useAiAccountsStore((s) => s.mainKeys);
	const loadError = useAiAccountsStore((s) => s.error);
	const load = useAiAccountsStore((s) => s.load);
	const save = useAiAccountsStore((s) => s.save);
	const remove = useAiAccountsStore((s) => s.remove);
	const test = useAiAccountsStore((s) => s.test);
	const setDefault = useAiAccountsStore((s) => s.setDefault);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tests, setTests] = useState<Record<string, AiAccountTestResult>>({});

	useEffect(() => {
		void load();
		void useAiAccountUsageStore.getState().load();
	}, [load]);

	const accounts = useMemo(() => aiAccountsOf(allAccounts, provider), [allAccounts, provider]);
	const hasMainKey = mainKeys.includes(provider);
	const pair = KEY_PAIR_PROVIDERS.includes(provider);
	const defaultId = defaults[provider];

	const runTest = async (id: string) => {
		setBusy(id);
		const result = await test(id);
		setTests((current) => ({ ...current, [id]: result }));
		setBusy(null);
	};

	const submit = async () => {
		if (!draft) return;
		setBusy("form");
		setError(null);
		const creating = draft.id === undefined;
		const result = await save({
			...(draft.id ? { id: draft.id } : {}),
			provider,
			name: draft.name,
			// Nothing typed keeps the saved key.
			apiKey: draft.apiKey ? draft.apiKey : undefined,
			...(pair ? { secretKey: draft.secretKey || undefined, region: draft.region.trim() || undefined } : {}),
		});
		setBusy(null);
		if (result.error || !result.account) {
			setError(result.error ?? t("aiAccounts.accounts.saveFailed"));
			return;
		}
		setDraft(null);
		const saved = result.account;
		// The provider's only key becomes its default, so it runs at once.
		if (creating && !hasMainKey && !defaultId) await setDefault(provider, saved.id);
		await runTest(saved.id);
	};

	const makeDefault = async (id: string | null) => {
		setBusy(id ?? "main");
		setError(await setDefault(provider, id));
		setBusy(null);
	};

	const confirmRemove = async (account: AiAccountView) => {
		const confirmed = await confirmAction({
			title: t("aiAccounts.accounts.deleteTitle", { name: account.name }),
			description:
				account.id === defaultId
					? t("aiAccounts.accounts.deleteDefaultDescription")
					: t("aiAccounts.accounts.deleteDescription"),
			destructive: true,
		});
		if (!confirmed) return;
		setError(await remove(account.id));
	};

	const isEmpty = accounts.length === 0 && !hasMainKey;

	return (
		<div className="space-y-3" data-testid="api-key-accounts">
			<p className="text-sm text-muted-foreground">
				{t("aiAccounts.accounts.apiKeyIntro", { provider: providerName })}
			</p>
			{(error || loadError) && (
				<Notice tone="red" role="alert">
					{error || loadError}
				</Notice>
			)}
			{isEmpty && !draft && <p className="text-sm text-muted-foreground">{t("aiAccounts.accounts.empty")}</p>}

			{hasMainKey && (
				<div
					data-testid="ai-account"
					data-account="main"
					className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
				>
					<div className="min-w-0 flex-1 space-y-0.5">
						<div className="flex items-center gap-2 text-sm font-medium">
							<KeyRound className="h-4 w-4" aria-hidden="true" />
							<span className="truncate">{t("aiAccounts.accounts.mainKey")}</span>
							{!defaultId && (
								<Chip tone="accent" dot={false}>
									{t("aiAccounts.accounts.default")}
								</Chip>
							)}
						</div>
						<p className="text-xs text-muted-foreground">{t("aiAccounts.accounts.mainKeyHint")}</p>
					</div>
					{defaultId && (
						<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => makeDefault(null)}>
							<Star className="mr-2 h-4 w-4" />
							{t("aiAccounts.accounts.useByDefault")}
						</Button>
					)}
				</div>
			)}

			{accounts.map((account) => {
				const isDefault = account.id === defaultId;
				const result = tests[account.id];
				return (
					<div
						key={account.id}
						data-testid="ai-account"
						data-account={account.id}
						className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
					>
						<div className="min-w-0 flex-1 space-y-0.5">
							<div className="flex items-center gap-2 text-sm font-medium">
								<KeyRound className="h-4 w-4" aria-hidden="true" />
								<span className="truncate">{account.name}</span>
								{isDefault && (
									<Chip tone="accent" dot={false}>
										{t("aiAccounts.accounts.default")}
									</Chip>
								)}
							</div>
							<p className="text-xs text-muted-foreground">
								{account.hasKey
									? account.keySetAt
										? t("aiAccounts.accounts.keySetOn", { date: formatAppDateTime(account.keySetAt) })
										: t("aiAccounts.accounts.keySet")
									: t("aiAccounts.accounts.noKey")}
								{account.region && ` · ${account.region}`}
							</p>
							<AccountSpend accountKey={account.id} />
							{result && <TestLine result={result} providerName={providerName} />}
						</div>
						<div className="flex flex-wrap gap-2">
							{!isDefault && account.hasKey && (
								<Button
									variant="outline"
									size="sm"
									disabled={busy !== null}
									onClick={() => makeDefault(account.id)}
								>
									<Star className="mr-2 h-4 w-4" />
									{t("aiAccounts.accounts.useByDefault")}
								</Button>
							)}
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null || !account.hasKey}
								onClick={() => runTest(account.id)}
							>
								{busy === account.id ? (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								) : (
									<Plug className="mr-2 h-4 w-4" />
								)}
								{t("aiAccounts.accounts.test")}
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null}
								aria-label={t("aiAccounts.accounts.edit", { name: account.name })}
								onClick={() =>
									setDraft({
										...EMPTY,
										id: account.id,
										name: account.name,
										hasKey: account.hasKey,
										hasSecret: account.hasSecret === true,
										region: account.region ?? "",
									})
								}
							>
								<Pencil className="h-4 w-4" />
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy !== null}
								aria-label={t("aiAccounts.accounts.delete", { name: account.name })}
								onClick={() => confirmRemove(account)}
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
					pair={pair}
					busy={busy === "form"}
					onChange={setDraft}
					onSubmit={() => void submit()}
					onCancel={() => {
						setDraft(null);
						setError(null);
					}}
				/>
			) : (
				<Button variant="outline" onClick={() => setDraft({ ...EMPTY })}>
					<Plus className="mr-2 h-4 w-4" />
					{t("aiAccounts.accounts.add")}
				</Button>
			)}
		</div>
	);
}
