/**
 * The AI account a project or a Kanban card runs on, per provider
 * (`shared/utils/ai-account-pins.ts`). One row per provider that has a choice:
 * a provider with saved API-key accounts (Settings → AI accounts), or Claude
 * with more than one signed-in profile. The first entry keeps what is
 * inherited: for a card, its project's pin, else the provider's default.
 *
 * Only ids leave this component; the main process looks the account up and
 * falls back to the default when it is gone.
 */

import type { AiAccountPins } from "@shared/types/ai-accounts";
import { CLAUDE_ACCOUNT_PROVIDER } from "@shared/types/ai-accounts";
import { pinProviderOf, withAccountPin } from "@shared/utils/ai-account-pins";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { aiAccountsOf, useAiAccountsStore } from "@/stores/ai-accounts-store";
import { loadClaudeProfiles, useClaudeProfileStore } from "@/stores/claude-profile-store";
import { providerName } from "../formula-lab/formula-utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const NO_PROFILES: AccountsSnapshot["claudeProfiles"] = [];

/** The value of the entry that keeps the inherited account. */
const INHERIT = "__inherit__";

interface AccountChoice {
	id: string;
	name: string;
}

export interface AccountPinRow {
	/** The key of the pin: an account provider or `claude`. */
	provider: string;
	choices: AccountChoice[];
	/** The account the provider runs on without a pin here, by name. */
	inheritedName: string;
}

interface AccountsSnapshot {
	accounts: ReturnType<typeof useAiAccountsStore.getState>["accounts"];
	defaults: Record<string, string>;
	claudeProfiles: readonly { id: string; name: string; email?: string }[];
	activeClaudeProfileId: string;
}

/**
 * The rows the editor shows for `providers`, each once, in their order. A
 * provider with no choice is left out, unless `value` pins it (so the pin can
 * be removed). Exported for tests.
 */
export function accountPinRows(
	providers: readonly string[],
	snapshot: AccountsSnapshot,
	labels: { mainKey: string; removed: string },
	inherited?: AiAccountPins,
	value?: AiAccountPins,
): AccountPinRow[] {
	const keys = [...new Set(providers.map(pinProviderOf).filter((key): key is string => !!key))];
	const rows: AccountPinRow[] = [];
	for (const key of keys) {
		const isClaude = key === CLAUDE_ACCOUNT_PROVIDER;
		const choices: AccountChoice[] = isClaude
			? snapshot.claudeProfiles.map((profile) => ({
					id: profile.id,
					name: profile.email ? `${profile.name} (${profile.email})` : profile.name,
				}))
			: aiAccountsOf(snapshot.accounts, key)
					.filter((account) => account.hasKey)
					.map((account) => ({ id: account.id, name: account.name }));
		const pinned = value?.[key];
		if (pinned && !choices.some((choice) => choice.id === pinned)) {
			choices.push({ id: pinned, name: labels.removed });
		}
		const hasChoice = isClaude ? choices.length > 1 : choices.length > 0;
		if (!hasChoice && !pinned) continue;
		const defaultId = isClaude ? snapshot.activeClaudeProfileId : snapshot.defaults[key];
		const inheritedId = inherited?.[key] ?? defaultId;
		const inheritedName =
			choices.find((choice) => choice.id === inheritedId)?.name ??
			// A Claude row always lists a profile; an API-key provider falls back to its main key.
			(isClaude ? choices[0].name : labels.mainKey);
		rows.push({ provider: key, choices, inheritedName });
	}
	return rows;
}

interface AiAccountPinsEditorProps {
	/** The providers to offer a pin for (aliases are merged). */
	readonly providers: readonly string[];
	readonly value: AiAccountPins | undefined;
	readonly onChange: (next: AiAccountPins | undefined) => void;
	/** What applies without a pin here: the project's pins, for a card. */
	readonly inherited?: AiAccountPins;
	/** `card` says "the project's" for an inherited pin; `project` says "default". */
	readonly scope: "card" | "project";
	readonly idPrefix: string;
	readonly disabled?: boolean;
}

export function AiAccountPinsEditor({
	providers,
	value,
	onChange,
	inherited,
	scope,
	idPrefix,
	disabled = false,
}: AiAccountPinsEditorProps) {
	const { t } = useTranslation(["settings"]);
	const { accounts, defaults, loaded } = useAiAccountsStore(
		useShallow((s) => ({ accounts: s.accounts, defaults: s.defaults, loaded: s.loaded })),
	);
	const { claudeProfiles, activeClaudeProfileId } = useClaudeProfileStore(
		useShallow((s) => ({
			// A profile list that did not load yet (or loaded malformed) is no profile.
			claudeProfiles: s.profiles ?? NO_PROFILES,
			activeClaudeProfileId: s.activeProfileId,
		})),
	);
	const wantsClaude = providers.some((p) => pinProviderOf(p) === CLAUDE_ACCOUNT_PROVIDER);

	useEffect(() => {
		if (!loaded) void useAiAccountsStore.getState().load();
	}, [loaded]);
	useEffect(() => {
		if (wantsClaude && claudeProfiles.length === 0) void loadClaudeProfiles();
	}, [wantsClaude, claudeProfiles.length]);

	const rows = useMemo(
		() =>
			accountPinRows(
				providers,
				{ accounts, defaults, claudeProfiles, activeClaudeProfileId },
				{
					mainKey: t("settings:aiAccounts.accounts.mainKey"),
					removed: t("settings:aiAccounts.pins.removed"),
				},
				inherited,
				value,
			),
		[providers, accounts, defaults, claudeProfiles, activeClaudeProfileId, inherited, value, t],
	);

	if (rows.length === 0) return null;

	return (
		<div className="space-y-2" data-testid={`${idPrefix}-account-pins`}>
			<div className="space-y-0.5">
				<div className="text-sm font-medium text-foreground">
					{t("settings:aiAccounts.pins.title")}
				</div>
				<p className="text-xs text-muted-foreground">
					{t(`settings:aiAccounts.pins.${scope}Description`)}
				</p>
			</div>
			<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{rows.map((row) => {
					const id = `${idPrefix}-account-${row.provider}`;
					const fromProject = scope === "card" && Boolean(inherited?.[row.provider]);
					const inheritLabel = t(
						fromProject
							? "settings:aiAccounts.pins.inheritProject"
							: "settings:aiAccounts.pins.inheritDefault",
						{ name: row.inheritedName },
					);
					return (
						<div key={row.provider} className="min-w-0 space-y-1">
							<label htmlFor={id} className="text-xs font-medium text-muted-foreground">
								{providerName(row.provider)}
							</label>
							<Select
								value={value?.[row.provider] ?? INHERIT}
								disabled={disabled}
								onValueChange={(next) =>
									onChange(withAccountPin(value, row.provider, next === INHERIT ? null : next))
								}
							>
								<SelectTrigger id={id} className="h-8">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
									{row.choices.map((choice) => (
										<SelectItem key={choice.id} value={choice.id}>
											{choice.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					);
				})}
			</div>
		</div>
	);
}
