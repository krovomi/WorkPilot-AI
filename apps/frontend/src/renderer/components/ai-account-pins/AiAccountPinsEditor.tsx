/**
 * The AI account a project or a Kanban card runs on, per provider
 * (`shared/utils/ai-account-pins.ts`). One row per provider that has a choice:
 * a provider with saved API-key accounts or signed-in CLI accounts (Copilot,
 * Gemini CLI; OpenAI lists its keys then its Codex CLI sign-ins) from
 * Settings → AI accounts, or Claude with more than one signed-in profile. The
 * first entry keeps what is inherited: for a card, its project's pin, else
 * the provider's default.
 *
 * Only ids leave this component; the main process looks the account up and
 * falls back to the default when it is gone.
 */

import type { AiAccountPins } from "@shared/types/ai-accounts";
import { CLAUDE_ACCOUNT_PROVIDER, LOGIN_CLI_NAMES, loginProviderOf } from "@shared/types/ai-accounts";
import { pinKeysOf, pinProviderOf, withAccountPin } from "@shared/utils/ai-account-pins";
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
	/** An API key or a Claude profile, or a CLI sign-in. */
	kind: "key" | "login";
}

export interface AccountPinRow {
	/** The provider of the row: an account provider, `claude` or a CLI provider. */
	provider: string;
	/** The keys its pin may be stored under (`openai`, `codex`). */
	keys: string[];
	choices: AccountChoice[];
	/** The account pinned here, under whichever of `keys`. */
	pinned?: string;
	/** The account the provider runs on without a pin here, by name. */
	inheritedName: string;
}

interface AccountsSnapshot {
	accounts: ReturnType<typeof useAiAccountsStore.getState>["accounts"];
	defaults: Record<string, string>;
	claudeProfiles: readonly { id: string; name: string; email?: string }[];
	activeClaudeProfileId: string;
}

/** What the editor writes beside an account's name. */
interface RowLabels {
	mainKey: string;
	removed: string;
	/** The sign-in of the CLI outside WorkPilot, for a row of CLI accounts only. */
	system: string;
	/** A CLI sign-in listed beside API keys: "Perso (Codex CLI)". */
	loginChoice: (name: string, cli: string) => string;
}

/** The choices of one row: Claude's profiles, a provider's keys, its CLI's sign-ins. */
function rowChoices(
	provider: string,
	keys: readonly string[],
	snapshot: AccountsSnapshot,
	labels: RowLabels,
): AccountChoice[] {
	if (provider === CLAUDE_ACCOUNT_PROVIDER) {
		return snapshot.claudeProfiles.map((profile) => ({
			id: profile.id,
			name: profile.email ? `${profile.name} (${profile.email})` : profile.name,
			kind: "key",
		}));
	}
	const login = loginProviderOf(provider);
	const keyed = keys
		.filter((key) => key !== login)
		.flatMap((key) => aiAccountsOf(snapshot.accounts, key).filter((account) => account.hasKey))
		.map((account): AccountChoice => ({ id: account.id, name: account.name, kind: "key" }));
	const signedIn = login
		? aiAccountsOf(snapshot.accounts, login)
				.filter((account) => account.signedIn)
				.map(
					(account): AccountChoice => ({
						id: account.id,
						// Beside keys, a sign-in says which CLI it is.
						name: keys.length > 1 ? labels.loginChoice(account.name, LOGIN_CLI_NAMES[login]) : account.name,
						kind: "login",
					}),
				)
		: [];
	return [...keyed, ...signedIn];
}

/**
 * The rows the editor shows for `providers`, each once, in their order. A
 * provider with no choice is left out, unless `value` pins it (so the pin can
 * be removed). Exported for tests.
 */
export function accountPinRows(
	providers: readonly string[],
	snapshot: AccountsSnapshot,
	labels: RowLabels,
	inherited?: AiAccountPins,
	value?: AiAccountPins,
): AccountPinRow[] {
	const rows: AccountPinRow[] = [];
	const seen = new Set<string>();
	for (const provider of providers) {
		const keys = pinKeysOf(provider);
		// Aliases, and Codex once OpenAI has its row.
		if (keys.length === 0 || keys.every((key) => seen.has(key))) continue;
		for (const key of keys) seen.add(key);
		const head = keys[0];
		const isClaude = head === CLAUDE_ACCOUNT_PROVIDER;
		const choices = rowChoices(head, keys, snapshot, labels);
		const pinnedKey = keys.find((key) => value?.[key]);
		const pinned = pinnedKey ? value?.[pinnedKey] : undefined;
		if (pinned && !choices.some((choice) => choice.id === pinned)) {
			const kind = pinnedKey === loginProviderOf(head) ? "login" : "key";
			choices.push({ id: pinned, name: labels.removed, kind });
		}
		const hasChoice = isClaude ? choices.length > 1 : choices.length > 0;
		if (!hasChoice && !pinned) continue;
		const inheritedId = isClaude
			? (inherited?.[head] ?? snapshot.activeClaudeProfileId)
			: (keys.map((key) => inherited?.[key]).find(Boolean) ??
				keys.map((key) => snapshot.defaults[key]).find(Boolean));
		const onlySignIns = !isClaude && keys.every((key) => key === loginProviderOf(head));
		const inheritedName =
			choices.find((choice) => choice.id === inheritedId)?.name ??
			// A Claude row always lists a profile; an API-key provider falls back to its
			// main key, a CLI to its sign-in outside WorkPilot.
			(isClaude ? choices[0].name : onlySignIns ? labels.system : labels.mainKey);
		rows.push({ provider: head, keys, choices, pinned, inheritedName });
	}
	return rows;
}

/** A row's title: the provider's name, or the CLI's for Codex on its own (no provider of that name). */
function rowTitle(provider: string): string {
	return provider === "codex" ? LOGIN_CLI_NAMES.codex : providerName(provider);
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
					system: t("settings:aiAccounts.accounts.login.system"),
					loginChoice: (name, cli) => t("settings:aiAccounts.pins.loginChoice", { name, cli }),
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
					const fromProject = scope === "card" && row.keys.some((key) => inherited?.[key]);
					const inheritLabel = t(
						fromProject
							? "settings:aiAccounts.pins.inheritProject"
							: "settings:aiAccounts.pins.inheritDefault",
						{ name: row.inheritedName },
					);
					return (
						<div key={row.provider} className="min-w-0 space-y-1">
							<label htmlFor={id} className="text-xs font-medium text-muted-foreground">
								{rowTitle(row.provider)}
							</label>
							<Select
								value={row.pinned ?? INHERIT}
								disabled={disabled}
								onValueChange={(next) => {
									const choice = row.choices.find((candidate) => candidate.id === next);
									onChange(withAccountPin(value, row.provider, choice?.id ?? null, choice?.kind));
								}}
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
