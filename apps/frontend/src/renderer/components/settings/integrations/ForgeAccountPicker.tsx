/**
 * Picks, on a project's forge settings, which saved forge account the project
 * works with, or its own token. The accounts are saved once for the app
 * (Settings, Forge accounts); the project only keeps the account's id, and the
 * main process lends its token, with the address it was saved for, to the
 * project's forge calls (`main/forge/forge-credentials.ts`).
 */

import { KeyRound } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ForgeKind } from "@shared/types/forge-accounts";
import { accountsOf, useForgeAccountsStore } from "../../../stores/forge-accounts-store";
import { Label } from "../../ui/label";
import { NativeSelect } from "../../ui/native-select";

interface ForgeAccountPickerProps {
	readonly forge: ForgeKind;
	/** The account id the project names; "" or undefined: its own token. */
	readonly value: string | undefined;
	readonly onChange: (accountId: string) => void;
}

export function ForgeAccountPicker({ forge, value, onChange }: ForgeAccountPickerProps) {
	const { t } = useTranslation("settings");
	const accounts = useForgeAccountsStore((s) => s.accounts);
	const loaded = useForgeAccountsStore((s) => s.loaded);
	const load = useForgeAccountsStore((s) => s.load);

	useEffect(() => {
		if (!loaded) void load();
	}, [loaded, load]);

	const own = accountsOf(accounts, forge);
	const selected = value ?? "";
	const missing = selected !== "" && loaded && !own.some((account) => account.id === selected);
	const id = `forge-account-${forge}`;

	return (
		<div className="space-y-2">
			<Label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-foreground">
				<KeyRound className="h-3 w-3" />
				{t("forgeAccounts.picker.label")}
			</Label>
			<NativeSelect
				id={id}
				className="w-full"
				value={selected}
				onChange={(e) => onChange(e.target.value)}
			>
				<option value="">{t("forgeAccounts.picker.ownToken")}</option>
				{own.map((account) => (
					<option key={account.id} value={account.id}>
						{account.username
							? t("forgeAccounts.picker.withUsername", {
									label: account.label,
									username: account.username,
								})
							: account.label}
					</option>
				))}
				{missing && <option value={selected}>{t("forgeAccounts.picker.missing")}</option>}
			</NativeSelect>
			<p className="text-xs text-muted-foreground">
				{missing
					? t("forgeAccounts.picker.missingHint")
					: own.length === 0
						? t("forgeAccounts.picker.noneHint")
						: t("forgeAccounts.picker.hint")}
			</p>
		</div>
	);
}
