/**
 * One AI account's month: what it spent, its tokens, and its optional monthly
 * budget with how much of it is used. Typing a budget sends a number to the
 * main process, which checks it and alerts at 80 % and at 100 % once a month
 * (`main/ai-accounts/account-usage.ts`). Figures come from the cost ledgers
 * of this computer only.
 */

import { Pencil, Wallet } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { formatTokens, formatUsd } from "@/components/administration/usage/usage-format";
import { Button, Input } from "@/components/ui";
import { usageOf, useAiAccountUsageStore } from "@/stores/ai-account-usage-store";
import { Bar, type Tone } from "../../charter";

const LEVEL_TONE: Record<string, Tone> = { ok: "green", warning: "amber", exceeded: "red" };

export function AccountSpend({ accountKey }: { readonly accountKey: string }) {
	const { t } = useTranslation("settings");
	const usage = useAiAccountUsageStore(useShallow((s) => usageOf(s.accounts, accountKey)));
	const setBudget = useAiAccountUsageStore((s) => s.setBudget);
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const tokens = usage.inputTokens + usage.outputTokens;
	const spent = t("aiAccounts.spend.month", {
		cost: formatUsd(usage.costUsd),
		tokens: formatTokens(tokens),
	});

	const submit = async () => {
		if (draft === null) return;
		const amount = draft.trim() === "" ? 0 : Number(draft.replace(",", "."));
		if (!Number.isFinite(amount) || amount < 0) {
			setError(t("aiAccounts.spend.invalid"));
			return;
		}
		const refused = await setBudget(accountKey, amount);
		setError(refused);
		if (!refused) setDraft(null);
	};

	return (
		<div className="space-y-1 pt-1" data-testid="account-spend">
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Wallet className="h-3.5 w-3.5" aria-hidden="true" />
				<span>{spent}</span>
				{!usage.complete && <span title={t("aiAccounts.spend.floorHint")}>{t("aiAccounts.spend.floor")}</span>}
			</p>
			{draft === null ? (
				<div className="flex items-center gap-2 text-xs">
					{usage.budgetUsd > 0 ? (
						<>
							<span className="w-24 shrink-0">
								<Bar
									value={(usage.costUsd / usage.budgetUsd) * 100}
									tone={LEVEL_TONE[usage.level] ?? "accent"}
								/>
							</span>
							<span className={usage.level === "exceeded" ? "text-destructive" : "text-muted-foreground"}>
								{t("aiAccounts.spend.budget", {
									budget: formatUsd(usage.budgetUsd),
									pct: Math.round((usage.costUsd / usage.budgetUsd) * 100),
								})}
							</span>
						</>
					) : (
						<span className="text-muted-foreground">{t("aiAccounts.spend.noBudget")}</span>
					)}
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-1.5"
						aria-label={t("aiAccounts.spend.editBudget")}
						onClick={() => setDraft(usage.budgetUsd > 0 ? String(usage.budgetUsd) : "")}
					>
						<Pencil className="h-3.5 w-3.5" />
					</Button>
				</div>
			) : (
				<form
					className="flex items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<Input
						aria-label={t("aiAccounts.spend.budgetLabel")}
						inputMode="decimal"
						className="h-7 w-28 text-xs"
						value={draft}
						placeholder={t("aiAccounts.spend.budgetPlaceholder")}
						autoFocus
						onChange={(event) => setDraft(event.target.value)}
					/>
					<Button type="submit" size="sm" variant="outline" className="h-7">
						{t("aiAccounts.accounts.save")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7"
						onClick={() => {
							setDraft(null);
							setError(null);
						}}
					>
						{t("aiAccounts.accounts.cancel")}
					</Button>
				</form>
			)}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
